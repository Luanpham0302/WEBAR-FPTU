-- Phase 2B: target pack compilation support.
--
-- Requires the four Phase 2A files. Run once, in the Supabase SQL editor.
-- One transaction: if any check fails, nothing is changed.
--
-- WHAT IT DOES
--   * Target packs and their items can no longer be written directly through
--     the API. Three functions are the only way in, and each one validates.
--   * A pack becomes "verified" only through cms_verify_target_pack(), which
--     checks that a file is stored at the reserved path with the reserved
--     size.
--   * A verified pack, its items and its file cannot be changed or deleted.
--   * A pack always contains every Ready artwork of its campaign.
--   * Duplicate trigger images are refused per campaign and per pack.
--   * Editors may upload a pack file, but only to a path they reserved.
--   * A release can only be created for a verified pack.
--
-- WHAT "VERIFIED" DOES NOT MEAN  (read before Phase 2C)
--   Postgres cannot read a stored file. The database therefore does NOT
--   check the contents of a .mind file and does NOT check its real SHA-256.
--   target_packs.sha256 is the value reported by the browser that compiled
--   the pack. "verified" means: reserved through the validated function,
--   mapping consistent with the artworks, file present, size equal.
--   It does NOT mean the pack is safe to publish. Phase 2C must not publish
--   a pack until a trusted backend has read the stored bytes, recomputed the
--   SHA-256 and parsed the MindAR file. See docs/phase-2c-requirements.md.
--
-- WHAT IT DOES NOT TOUCH
--   ar_content, ar-assets, campaigns.live_release_id, user_roles, any stored
--   file, and every existing row including every release. It adds rules; it
--   writes no data. On public.releases it adds one trigger (insert and
--   update) and changes nothing else.
--
-- CHANGED PHASE 2A OBJECTS (all listed in the review report)
--   dropped : policy target_packs_insert      on public.target_packs
--             policy target_packs_update      on public.target_packs
--             policy target_pack_items_insert on public.target_pack_items
--   replaced: function public.cms_guard_target_pack()
--   added to: public.releases gets a BEFORE INSERT OR UPDATE trigger
--             (cms_guard_pack)
--   kept    : every SELECT policy and every other table and policy. The two
--             Admin DELETE policies stay but a trigger now refuses the delete.

begin;

-- ================================================================ preflight

do $$
declare
  v_problem text;
begin
  if to_regprocedure('public.cms_reserve_target_pack(uuid,text,text,text,bigint,text,text,jsonb)') is not null then
    raise exception
      'This migration has already been applied (cms_reserve_target_pack exists). Nothing was changed.';
  end if;

  if to_regprocedure('public.cms_has_role(text)') is null
     or to_regclass('public.target_packs') is null
     or to_regclass('public.target_pack_items') is null
     or to_regclass('public.user_roles') is null then
    raise exception
      'The Phase 2A migrations are not fully applied. Apply them first. Nothing was changed.';
  end if;

  -- The three policies this file removes must be the ones Phase 2A created.
  select string_agg(expected.name, ', ')
    into v_problem
    from (values
            ('target_packs', 'target_packs_insert'),
            ('target_packs', 'target_packs_update'),
            ('target_pack_items', 'target_pack_items_insert')
         ) as expected (tbl, name)
    left join pg_policies p
      on p.schemaname = 'public' and p.tablename = expected.tbl and p.policyname = expected.name
   where p.policyname is null;

  if v_problem is not null then
    raise exception
      'Expected Phase 2A policies are missing: %. Review before continuing. Nothing was changed.',
      v_problem;
  end if;

  -- No other policy may allow a direct write to the two pack tables. A
  -- permissive INSERT, UPDATE or ALL policy that this file does not know
  -- about would survive it and bypass the validated functions.
  select string_agg(format('%I on %I (%s)', policyname, tablename, cmd), ', ')
    into v_problem
    from pg_policies
   where schemaname = 'public'
     and tablename in ('target_packs', 'target_pack_items')
     and cmd in ('INSERT', 'UPDATE', 'ALL')
     and policyname not in ('target_packs_insert', 'target_packs_update',
                            'target_pack_items_insert');

  if v_problem is not null then
    raise exception
      'Unexpected write policies on the target pack tables: %. Remove or review them first. Nothing was changed.',
      v_problem;
  end if;

  -- The storage rules below bind signed-in users. They do not bind the anon
  -- role, so no policy may give anonymous visitors a storage write.
  select string_agg(format('%I (%s)', policyname, cmd), ', ')
    into v_problem
    from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     and ('anon' = any (roles) or 'public' = any (roles));

  if v_problem is not null then
    raise exception
      'Storage policies allow anonymous writes: %. Remove or review them first. Nothing was changed.',
      v_problem;
  end if;

  -- A status-only update must reach the guard trigger unchanged. That holds
  -- only while target_packs has no updated_at column and no other trigger
  -- that rewrites the row before an update. (Phase 2A: cms_stamp is
  -- BEFORE INSERT only; cms_guard is the one BEFORE UPDATE trigger.)
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'target_packs'
       and column_name in ('updated_at', 'updated_by')
  ) then
    raise exception
      'target_packs has an updated_at/updated_by column, which the immutability guard would reject on every status change. Nothing was changed.';
  end if;

  select string_agg(t.tgname, ', ')
    into v_problem
    from pg_trigger t
   where t.tgrelid = 'public.target_packs'::regclass
     and not t.tgisinternal
     and (t.tgtype & 2) = 2      -- BEFORE
     and (t.tgtype & 16) = 16    -- UPDATE
     and t.tgname <> 'cms_guard';

  if v_problem is not null then
    raise exception
      'Unexpected BEFORE UPDATE triggers on target_packs: %. Review them first. Nothing was changed.',
      v_problem;
  end if;

  -- Existing data must already satisfy the new uniqueness rules.
  select string_agg(format('campaign %s, sha256 %s', campaign_id, trigger_sha256), '; ')
    into v_problem
    from (
      select campaign_id, trigger_sha256
        from public.artworks
       where trigger_sha256 is not null
         and status <> 'archived'
       group by campaign_id, trigger_sha256
      having count(*) > 1
    ) d;

  if v_problem is not null then
    raise exception
      'Artworks share a trigger image. Fix them first, then run this again: %. Nothing was changed.',
      v_problem;
  end if;

  select string_agg(format('pack %s, sha256 %s', pack_id, trigger_sha256), '; ')
    into v_problem
    from (
      select pack_id, trigger_sha256
        from public.target_pack_items
       group by pack_id, trigger_sha256
      having count(*) > 1
    ) d;

  if v_problem is not null then
    raise exception
      'Existing target packs contain the same trigger twice: %. Nothing was changed.',
      v_problem;
  end if;
end;
$$;

-- ======================================================= duplicate triggers
-- Two artworks with the same trigger image in one campaign cannot be told
-- apart by MindAR. Archived artworks do not count, and other campaigns are
-- not affected: the campaign is part of the key.

create unique index artworks_campaign_trigger_unique_idx
  on public.artworks (campaign_id, trigger_sha256)
  where trigger_sha256 is not null and status <> 'archived';

alter table public.target_pack_items
  add constraint target_pack_items_trigger_unique unique (pack_id, trigger_sha256);

-- =============================================================== constants

-- The one MindAR version a pack may be compiled with. It must equal the
-- version pinned in package.json. Upgrading MindAR is a deliberate migration
-- that replaces this function.
create function public.cms_mindar_version()
returns text
language sql
immutable
set search_path = ''
as $$ select '1.2.5'::text $$;

-- The largest pack file the database will reserve: 50 MB.
--
-- This is the Supabase Storage limit, not a MindAR one. A project's global
-- upload limit is 50 MB by default and cannot be raised above 50 MB on the
-- Free plan. ar-media has no bucket limit of its own, so the global limit is
-- what storage enforces. Reserving a larger pack would only produce a version
-- whose upload storage then refuses. If the project limit is raised (paid
-- plans), raise this with a migration that replaces the function, and keep
-- MAX_PACK_BYTES in src/cms/targetPack.ts equal to it.
create function public.cms_pack_max_bytes()
returns bigint
language sql
immutable
set search_path = ''
as $$ select 52428800::bigint $$;

-- Identifies "these images, in this order, with this compiler". Computed by
-- the server from the items, so it cannot disagree with them. The admin
-- computes the same value (src/cms/targetPack.ts, computeSourceHash) to tell
-- whether anything changed since the last pack.
create function public.cms_pack_source_hash(p_compiler_version text, p_items jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    sha256(convert_to(
      'mind-ar@' || p_compiler_version || E'\n' ||
      string_agg(
        (i ->> 'target_index') || ':' || (i ->> 'trigger_sha256') || ':' ||
        (i ->> 'width') || 'x' || (i ->> 'height'),
        E'\n' order by (i ->> 'target_index')::integer
      ),
      'UTF8')),
    'hex')
    from jsonb_array_elements(p_items) i;
$$;

-- =========================================================== pack lifecycle
-- uploaded : version reserved, items written, file upload in progress
-- verified : a file is stored at the reserved path with the reserved size,
--            and the mapping is complete. NOT a check of the file contents.
-- failed   : upload or verification did not finish; never usable
-- retired  : was verified and never used by any release; hidden from
--            the list of packs offered for a new release
--
-- Allowed moves, enforced here for every caller including the functions
-- below:
--   uploaded -> verified | failed
--   verified -> retired
--   retired  -> verified
-- A pack can only become verified with all of its items present. Every
-- other column is frozen from the moment the row exists.

create or replace function public.cms_guard_target_pack()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_items integer;
begin
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'A target pack is immutable. Only its status can change.'
      using errcode = '23514';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'uploaded' and new.status in ('verified', 'failed'))
      or (old.status = 'verified' and new.status = 'retired')
      or (old.status = 'retired' and new.status = 'verified')
    ) then
      raise exception 'A target pack cannot go from % to %.', old.status, new.status
        using errcode = '23514';
    end if;

    if old.status = 'uploaded' and new.status = 'verified' then
      select count(*) into v_items
        from public.target_pack_items
       where pack_id = new.id;

      if v_items <> new.target_count then
        raise exception
          'Target pack has % of % items and cannot be verified.', v_items, new.target_count
          using errcode = '23514';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- Items are written once, while the pack is being created.
create function public.cms_guard_target_pack_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pack public.target_packs;
begin
  select * into v_pack from public.target_packs where id = new.pack_id;

  if v_pack.status is distinct from 'uploaded' then
    raise exception 'Items can only be added while a target pack is being created.'
      using errcode = '23514';
  end if;

  if new.target_index >= v_pack.target_count then
    raise exception 'targetIndex % is outside a pack of % targets.',
      new.target_index, v_pack.target_count
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger cms_guard before insert on public.target_pack_items
  for each row execute function public.cms_guard_target_pack_item();

-- Phase 2A lets an Admin delete packs and items (cleanup). Deleting items
-- would let a verified pack lose part of its mapping, and deleting a pack
-- row would free its version number, so the next pack would get the same
-- number and the same storage path. Pack rows and items are therefore a
-- permanent record. Cleanup of a failed pack means removing its file, which
-- an Admin can still do; the small row stays.
create function public.cms_guard_target_pack_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'Target packs and their items are a permanent record and cannot be deleted. An Admin can remove the file of a failed pack instead.'
    using errcode = '23514';
end;
$$;

create trigger cms_guard_delete before delete on public.target_packs
  for each row execute function public.cms_guard_target_pack_delete();
create trigger cms_guard_delete before delete on public.target_pack_items
  for each row execute function public.cms_guard_target_pack_delete();

-- ========================================== no direct writes through the API
-- Phase 2A allowed an Editor to INSERT packs and items and UPDATE a pack
-- directly. That bypasses every check below, so those three policies go.
-- With no INSERT or UPDATE policy left, row level security refuses direct
-- writes from every signed-in user. Reading is unchanged.

drop policy target_packs_insert on public.target_packs;
drop policy target_packs_update on public.target_packs;
drop policy target_pack_items_insert on public.target_pack_items;

-- Prove it: nothing may be left that lets a signed-in user write directly.
do $$
declare
  v_left text;
begin
  select string_agg(format('%I on %I (%s)', policyname, tablename, cmd), ', ')
    into v_left
    from pg_policies
   where schemaname = 'public'
     and tablename in ('target_packs', 'target_pack_items')
     and cmd in ('INSERT', 'UPDATE', 'ALL');

  if v_left is not null then
    raise exception
      'Direct write policies remain on the target pack tables: %. Nothing was changed.', v_left;
  end if;
end;
$$;

-- ============================================================ 1. reserve
-- Called after a successful compile and before the upload. In one
-- transaction it validates the compiled mapping against the artworks, takes
-- the next version under a lock, and writes the pack with its complete
-- targetIndex mapping.
--
-- SECURITY DEFINER: it is the only writer, so it checks the role itself.
--
-- A PACK IS THE WHOLE CAMPAIGN, NOT A SELECTION. The items must be exactly
-- the Ready artworks of the campaign at the moment of reservation: every
-- item must be a Ready artwork, and every Ready artwork must be an item.
-- Leaving an artwork out is done by setting it to Draft, not by omitting it
-- from the list. This is checked under locks, so an artwork that becomes
-- Ready, stops being Ready, is added or gets a new trigger while a pack is
-- compiling makes the reservation fail with "compile again" rather than
-- produce a pack that silently disagrees with the campaign.
--
-- p_items: [{ "target_index": 0, "artwork_id": "...", "trigger_media_id":
--   "...", "trigger_sha256": "...", "width": 1254, "height": 1254,
--   "feature_count": 4746 }, ...] in compiler input order.

create function public.cms_reserve_target_pack(
  p_campaign_id      uuid,
  p_storage_provider text,
  p_bucket           text,
  p_sha256           text,
  p_file_size        bigint,
  p_source_hash      text,
  p_compiler_version text,
  p_items            jsonb
)
returns public.target_packs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count   integer;
  v_ready   integer;
  v_version integer;
  v_stale   text;
  v_pack    public.target_packs;
begin
  if not public.cms_has_role('editor') then
    raise exception 'Only an Editor or Admin can create a target pack.'
      using errcode = '42501';
  end if;

  -- Reported by the compiling browser. Checked for shape here; the database
  -- cannot check that it is the hash of the stored file.
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception
      'The file hash must be a SHA-256 written as 64 lower-case hexadecimal characters.'
      using errcode = '22023';
  end if;

  if p_file_size is null or p_file_size <= 0 then
    raise exception 'The file size must be greater than zero.'
      using errcode = '22023';
  end if;

  if p_file_size > public.cms_pack_max_bytes() then
    raise exception
      'This target pack is % MB. The largest pack that can be stored is % MB. Use fewer or smaller trigger images.',
      round(p_file_size / 1048576.0, 1), public.cms_pack_max_bytes() / 1048576
      using errcode = '22023';
  end if;

  -- Packs are public runtime files and live in one known place.
  if p_storage_provider is distinct from 'supabase' or p_bucket is distinct from 'ar-media' then
    raise exception 'Target packs can only be stored in the ar-media bucket.'
      using errcode = '22023';
  end if;

  if p_compiler_version is distinct from public.cms_mindar_version() then
    raise exception 'Target packs must be compiled with MindAR %, not %.',
      public.cms_mindar_version(), coalesce(p_compiler_version, '(none)')
      using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'A target pack needs at least one target.'
      using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_items);

  if v_count > 200 then
    raise exception 'A target pack cannot have more than 200 targets.'
      using errcode = '22023';
  end if;

  -- The indexes must be exactly 0 .. n-1, each once.
  if (
    select array_agg((i ->> 'target_index')::integer order by (i ->> 'target_index')::integer)
      from jsonb_array_elements(p_items) i
  ) is distinct from (
    select array_agg(g order by g) from generate_series(0, v_count - 1) g
  ) then
    raise exception 'Target indexes must be 0 to % with no gaps or repeats.', v_count - 1
      using errcode = '22023';
  end if;

  -- The source hash is derived from the items. A client that disagrees is
  -- out of date or wrong, and is refused.
  if p_source_hash is distinct from public.cms_pack_source_hash(p_compiler_version, p_items) then
    raise exception 'The source hash does not match the compiled targets.'
      using errcode = '22023';
  end if;

  -- Freeze the campaign until this transaction ends.
  --
  -- The campaign row, FOR UPDATE: only one reservation per campaign runs at
  -- a time, and nobody can insert a new artwork into the campaign meanwhile
  -- (an insert needs a key-share lock on this row for its foreign key).
  perform 1 from public.campaigns c where c.id = p_campaign_id for update;

  if not found then
    raise exception 'Campaign not found.' using errcode = 'P0002';
  end if;

  -- Every artwork of the campaign, FOR SHARE: nobody can change a status or
  -- a trigger meanwhile. A change that is already in flight makes this wait
  -- until it commits, and the checks below then see it.
  perform 1 from public.artworks a where a.campaign_id = p_campaign_id for share;

  -- Every target must be a Ready artwork of this campaign whose current
  -- trigger is exactly the image that was compiled.
  select string_agg(coalesce(i ->> 'artwork_id', '?'), ', ')
    into v_stale
    from jsonb_array_elements(p_items) i
    left join public.artworks a
      on a.id = (i ->> 'artwork_id')::uuid
     and a.campaign_id = p_campaign_id
     and a.status = 'ready'
     and a.trigger_media_id = (i ->> 'trigger_media_id')::uuid
     and a.trigger_sha256 = i ->> 'trigger_sha256'
     and a.trigger_width = (i ->> 'width')::integer
     and a.trigger_height = (i ->> 'height')::integer
   where a.id is null;

  if v_stale is not null then
    raise exception
      'These artworks changed while the pack was compiling: %. Compile again.', v_stale
      using errcode = '40001';
  end if;

  -- ...and every Ready artwork must be a target. Each item matched a
  -- different Ready artwork above (the same artwork twice cannot be stored),
  -- so equal counts mean the two sets are the same.
  select count(*) into v_ready
    from public.artworks a
   where a.campaign_id = p_campaign_id
     and a.status = 'ready';

  if v_ready <> v_count then
    raise exception
      'The campaign has % Ready artworks but % were compiled. The set of Ready artworks changed. Compile again.',
      v_ready, v_count
      using errcode = '40001';
  end if;

  -- The campaign lock taken above serialises reservations, so this number
  -- cannot be handed out twice. UNIQUE (campaign_id, version) from Phase 2A
  -- is the backstop.
  select coalesce(max(version), 0)
    into v_version
    from public.target_packs
   where campaign_id = p_campaign_id;

  -- Pack rows are never deleted, so this number only goes up. A path that
  -- already holds a file (left over from anything) is skipped, never reused.
  loop
    v_version := v_version + 1;
    exit when not exists (
      select 1
        from storage.objects o
       where o.bucket_id = p_bucket
         and o.name = format('targets/%s/v%s/targets.mind', p_campaign_id, v_version)
    );
  end loop;

  insert into public.target_packs (
    campaign_id, version, storage_provider, bucket, storage_key,
    sha256, file_size, target_count, source_hash, compiler_version, status
  )
  values (
    p_campaign_id, v_version, p_storage_provider, p_bucket,
    format('targets/%s/v%s/targets.mind', p_campaign_id, v_version),
    p_sha256, p_file_size, v_count, p_source_hash, p_compiler_version, 'uploaded'
  )
  returning * into v_pack;

  insert into public.target_pack_items (
    pack_id, target_index, artwork_id, trigger_media_id,
    trigger_sha256, width, height, feature_count
  )
  select v_pack.id,
         (i ->> 'target_index')::integer,
         (i ->> 'artwork_id')::uuid,
         (i ->> 'trigger_media_id')::uuid,
         i ->> 'trigger_sha256',
         (i ->> 'width')::integer,
         (i ->> 'height')::integer,
         (i ->> 'feature_count')::integer
    from jsonb_array_elements(p_items) i;

  return v_pack;
end;
$$;

-- ============================================================= 2. verify
-- The only way a pack becomes verified. Only the person who reserved it can
-- call this. It fails closed: the file must be in storage at the reserved
-- path, storage must report a size for it, and that size must equal the
-- reserved size. The trigger above then checks that every item is present.
--
-- CONTENT IS NOT VERIFIED HERE. Postgres cannot read the stored bytes. This
-- function does not check that the file is a MindAR target file, does not
-- check how many targets it holds, and does not check its SHA-256. A file of
-- the right size with any contents passes. The admin page downloads the
-- stored file and compares its SHA-256 before calling this, but that runs in
-- the editor's browser and is not a control against a hostile Editor.
-- Publishing (Phase 2C) needs a trusted backend check of the real bytes.

create function public.cms_verify_target_pack(p_pack_id uuid)
returns public.target_packs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pack  public.target_packs;
  v_size  text;
begin
  if not public.cms_has_role('editor') then
    raise exception 'Only an Editor or Admin can verify a target pack.'
      using errcode = '42501';
  end if;

  select * into v_pack from public.target_packs where id = p_pack_id for update;

  if not found then
    raise exception 'Target pack not found.' using errcode = 'P0002';
  end if;

  if v_pack.status <> 'uploaded' then
    raise exception 'Target pack v% is % and cannot be verified.',
      v_pack.version, v_pack.status
      using errcode = '23514';
  end if;

  if v_pack.created_by is distinct from auth.uid() then
    raise exception 'Only the person who compiled this target pack can verify it.'
      using errcode = '42501';
  end if;

  select o.metadata ->> 'size'
    into v_size
    from storage.objects o
   where o.bucket_id = v_pack.bucket
     and o.name = v_pack.storage_key;

  if not found then
    raise exception 'The file of target pack v% is not in storage.', v_pack.version
      using errcode = '23514';
  end if;

  -- Fail closed: no size, or anything that is not a plain positive number,
  -- is treated as "cannot be verified", never as "probably fine".
  if v_size is null or v_size !~ '^[0-9]{1,18}$' or v_size::bigint <= 0 then
    raise exception
      'Storage reports no valid size for the file of target pack v%, so it cannot be verified.',
      v_pack.version
      using errcode = '23514';
  end if;

  if v_size::bigint <> v_pack.file_size then
    raise exception
      'The stored file of target pack v% is % bytes, but % bytes were compiled.',
      v_pack.version, v_size, v_pack.file_size
      using errcode = '23514';
  end if;

  update public.target_packs
     set status = 'verified'
   where id = p_pack_id
  returning * into v_pack;

  return v_pack;
end;
$$;

comment on function public.cms_verify_target_pack(uuid) is
  'Marks a reserved target pack verified after checking that a file exists at its reserved path with its reserved size. Does NOT read the file: it does not validate the .mind contents, the target count inside the file, or the SHA-256. Not sufficient on its own to make a pack safe to publish.';

comment on column public.target_packs.sha256 is
  'SHA-256 reported by the browser that compiled the pack. Shape-checked only; the database cannot compare it with the stored file. A trusted backend must recompute it before the pack is published.';

comment on column public.target_packs.status is
  'uploaded | verified | failed | retired. verified = reserved through the validated function, mapping complete, file present, size equal. It is not a statement about the contents of the file.';

-- ================================================== 3. other status changes
-- failed  : from uploaded. By its creator at any time; by another Editor
--           only once the upload has clearly been abandoned.
-- retired : from verified, and only if NO release references the pack, in
--           any status. A superseded release is what a rollback republishes,
--           so its pack must stay usable; a pack that was ever released is
--           therefore never retired. Retiring is only for packs that were
--           built and then not used.
-- verified: only from retired (undoing a retire). A pack that was never
--           verified cannot get here.
--
-- Consequence relied on by Phase 2C: every release, including every
-- superseded one, points at a pack whose status is 'verified'. Rollback
-- never has to deal with a retired or failed pack.

create function public.cms_set_target_pack_status(p_pack_id uuid, p_status text)
returns public.target_packs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pack public.target_packs;
begin
  if not public.cms_has_role('editor') then
    raise exception 'Only an Editor or Admin can change a target pack.'
      using errcode = '42501';
  end if;

  select * into v_pack from public.target_packs where id = p_pack_id for update;

  if not found then
    raise exception 'Target pack not found.' using errcode = 'P0002';
  end if;

  if p_status = 'failed' then
    if v_pack.status <> 'uploaded' then
      raise exception 'Target pack v% is % and cannot be marked failed.',
        v_pack.version, v_pack.status
        using errcode = '23514';
    end if;

    if v_pack.created_by is distinct from auth.uid()
       and v_pack.created_at > now() - interval '10 minutes' then
      raise exception 'Target pack v% is still being uploaded by someone else.', v_pack.version
        using errcode = '23514';
    end if;
  elsif p_status = 'retired' then
    if v_pack.status <> 'verified' then
      raise exception 'Only a verified target pack can be retired.'
        using errcode = '23514';
    end if;

    -- Any status: preview, published or superseded. The row lock taken above
    -- and the lock in cms_guard_release_pack() make this check and a
    -- concurrent release insert see each other.
    if exists (
      select 1
        from public.releases r
       where r.target_pack_id = p_pack_id
    ) then
      raise exception
        'Target pack v% is used by a release and cannot be retired. A released pack is kept so the release can be rolled back to.',
        v_pack.version
        using errcode = '23514';
    end if;
  elsif p_status = 'verified' then
    if v_pack.status <> 'retired' then
      raise exception 'Only a retired target pack can be restored.'
        using errcode = '23514';
    end if;
  else
    raise exception 'Unknown target pack status: %.', coalesce(p_status, '(none)')
      using errcode = '22023';
  end if;

  update public.target_packs
     set status = p_status
   where id = p_pack_id
  returning * into v_pack;

  return v_pack;
end;
$$;

-- ============================================= releases use verified packs
-- Phase 2A lets an Editor insert a preview release for any pack, including
-- a failed or retired one. A release may only be created for a verified
-- pack. Together with the retire rule above this keeps the invariant that
-- every release points at a verified pack.
--
-- This is the only change to public.releases: one BEFORE INSERT OR UPDATE
-- trigger. No existing release is read or changed, and publishing is not
-- implemented.
--
-- It checks two things about the pack a release points at:
--   1. the pack belongs to the SAME campaign as the release;
--   2. the pack is verified.
--
-- When it checks:
--   INSERT : always.
--   UPDATE : when target_pack_id or campaign_id changes, and when the status
--            becomes 'published' (a publish, or a rollback republishing a
--            superseded release). Other updates, such as marking a release
--            superseded or editing notes, are not its concern and pass.
--
-- Phase 2A already covers part of this, and this trigger does not rely on
-- it: the composite foreign key (target_pack_id, campaign_id) refuses a pack
-- of another campaign, and cms_guard_release() refuses any change to
-- target_pack_id or campaign_id. If either were ever dropped or disabled,
-- the rules above would still hold.
--
-- SECURITY DEFINER because it locks the pack row: under row level security
-- a row lock needs an UPDATE policy, and target_packs no longer has one.
-- FOR SHARE makes a concurrent retire wait, and makes this wait for one.

create function public.cms_guard_release_pack()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status   text;
  v_campaign uuid;
begin
  if tg_op = 'UPDATE'
     and new.target_pack_id is not distinct from old.target_pack_id
     and new.campaign_id is not distinct from old.campaign_id
     and not (new.status = 'published' and old.status is distinct from 'published') then
    return new;
  end if;

  select p.status, p.campaign_id
    into v_status, v_campaign
    from public.target_packs p
   where p.id = new.target_pack_id
     for share;

  if not found then
    raise exception 'A release must use an existing target pack.'
      using errcode = '23503';
  end if;

  if v_campaign is distinct from new.campaign_id then
    raise exception 'A release can only use a target pack of its own campaign.'
      using errcode = '23514';
  end if;

  if v_status is distinct from 'verified' then
    raise exception 'A release can only use a verified target pack. This one is %.',
      v_status
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger cms_guard_pack before insert or update on public.releases
  for each row execute function public.cms_guard_release_pack();

-- ================================================================== storage
-- Pack files: ar-media / targets/{campaign-id}/v{n}/targets.mind
--
-- An Editor may upload a pack file only to the exact path of a pack that
-- they reserved themselves and that is still being created. Nobody can
-- upload to an arbitrary targets/ path.
--
-- These rules must hold whatever other storage policies exist, now or
-- later. A permissive policy only ever adds permission, so one broad policy
-- written for another purpose could open a hole. The three RESTRICTIVE
-- policies below are ANDed with everything else and cannot be overridden by
-- a permissive policy:
--   insert : nothing lands under ar-media/targets/ except a reserved file
--   update : the object of a target pack can never be changed, and no
--            object can be moved or renamed onto a targets/ path
--   delete : the file of a pack that is not failed can never be deleted
-- For every other object in every bucket they evaluate to true and change
-- nothing.

create function public.cms_is_reserved_pack_object(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.target_packs p
     where p.bucket = p_bucket
       and p.storage_key = p_name
       and p.status = 'uploaded'
       and p.created_by = (select auth.uid())
  );
$$;

-- True for the file of any pack that is not failed. Such a file must not be
-- deleted through the API, not even by an Admin.
create function public.cms_is_protected_pack_object(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.target_packs p
     where p.bucket = p_bucket
       and p.storage_key = p_name
       and p.status <> 'failed'
  );
$$;

create policy cms_target_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ar-media'
    and (storage.foldername(name))[1] = 'targets'
    and (select public.cms_has_role('editor'))
    and public.cms_is_reserved_pack_object(bucket_id, name)
  );

-- True for the object of any pack row, whatever its status.
create function public.cms_is_pack_object(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.target_packs p
     where p.bucket = p_bucket
       and p.storage_key = p_name
  );
$$;

create policy cms_pack_objects_insert_guard on storage.objects
  as restrictive
  for insert to authenticated
  with check (
    not (bucket_id = 'ar-media' and (storage.foldername(name))[1] = 'targets')
    or public.cms_is_reserved_pack_object(bucket_id, name)
  );

create policy cms_pack_objects_update_guard on storage.objects
  as restrictive
  for update to authenticated
  using (not public.cms_is_pack_object(bucket_id, name))
  with check (
    not public.cms_is_pack_object(bucket_id, name)
    and not (bucket_id = 'ar-media' and (storage.foldername(name))[1] = 'targets')
  );

create policy cms_pack_objects_protect on storage.objects
  as restrictive
  for delete to authenticated
  using (not public.cms_is_protected_pack_object(bucket_id, name));

-- ================================================================== grants
-- New functions in the public schema are callable by anon by default on
-- Supabase. Remove that everywhere; signed-in users get only what they need.

-- Trigger functions cannot be called directly, but keep them closed anyway.
revoke all on function public.cms_guard_target_pack() from public, anon, authenticated;
revoke all on function public.cms_guard_target_pack_item() from public, anon, authenticated;
revoke all on function public.cms_guard_target_pack_delete() from public, anon, authenticated;
revoke all on function public.cms_guard_release_pack() from public, anon, authenticated;

revoke all on function public.cms_mindar_version() from public, anon;
revoke all on function public.cms_pack_max_bytes() from public, anon;
grant execute on function public.cms_pack_max_bytes() to authenticated;
revoke all on function public.cms_pack_source_hash(text, jsonb) from public, anon;
revoke all on function public.cms_reserve_target_pack(
  uuid, text, text, text, bigint, text, text, jsonb) from public, anon;
revoke all on function public.cms_verify_target_pack(uuid) from public, anon;
revoke all on function public.cms_set_target_pack_status(uuid, text) from public, anon;
revoke all on function public.cms_is_reserved_pack_object(text, text) from public, anon;
revoke all on function public.cms_is_protected_pack_object(text, text) from public, anon;
revoke all on function public.cms_is_pack_object(text, text) from public, anon;

grant execute on function public.cms_is_pack_object(text, text) to authenticated;
grant execute on function public.cms_mindar_version() to authenticated;
grant execute on function public.cms_pack_source_hash(text, jsonb) to authenticated;
grant execute on function public.cms_reserve_target_pack(
  uuid, text, text, text, bigint, text, text, jsonb) to authenticated;
grant execute on function public.cms_verify_target_pack(uuid) to authenticated;
grant execute on function public.cms_set_target_pack_status(uuid, text) to authenticated;
-- Needed because storage policies run these as the uploading user.
grant execute on function public.cms_is_reserved_pack_object(text, text) to authenticated;
grant execute on function public.cms_is_protected_pack_object(text, text) to authenticated;

commit;
