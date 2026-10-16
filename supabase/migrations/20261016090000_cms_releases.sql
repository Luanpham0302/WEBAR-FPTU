-- Phase 2C.2 — immutable release snapshots, trusted pack gate and global publish.
-- STAGING ONLY. Apply after Phase 2C.1. All steps run in one transaction.
-- The backend verifier is a separate Supabase Edge Function.
begin;

do $$
begin
  if to_regprocedure('public.cms_create_release(uuid,text)') is not null
     or to_regclass('public.cms_trusted_pack_checks') is not null then
    raise exception 'Phase 2C.2 already installed or partially present. No changes made.';
  end if;
  if to_regprocedure('public.cms_guard_artwork_layer()') is null
     or to_regprocedure('public.cms_verify_target_pack(uuid)') is null then
    raise exception 'Phase 2C.1 and 2B must be installed first.';
  end if;
  if (select count(*) from public.releases where status = 'published') > 1
     or (select count(*) from public.campaigns where live_release_id is not null) > 1 then
    raise exception 'Multiple live releases exist. Review current pointers before migration.';
  end if;
end
$$;

-- Only service_role (trusted server code) can record a verified blob.
create table public.cms_trusted_pack_checks (
  pack_id uuid primary key references public.target_packs(id) on delete restrict,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  verifier_version text not null check (verifier_version = 'mind-ar@1.2.5'),
  verified_at timestamptz not null default now(),
  verified_by uuid references auth.users(id) on delete set null
);
alter table public.cms_trusted_pack_checks enable row level security;
revoke all on public.cms_trusted_pack_checks from public, anon, authenticated;
grant select, insert, update on public.cms_trusted_pack_checks to service_role;

-- A site has only one live campaign/release at a time, not one per campaign.
create unique index cms_site_one_published on public.releases ((true))
  where status = 'published';
create unique index cms_site_one_live_pointer on public.campaigns ((true))
  where live_release_id is not null;

-- A function-owner check prevents client Admin users from switching publish
-- fields directly. The approved SECURITY DEFINER publish function runs as
-- its owner. Database operators retain normal privileged SQL access.
create function public.cms_publish_release(p_release_id uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_release public.releases;
  v_pack public.target_packs;
  v_actor uuid := auth.uid();
begin
  if not public.cms_has_role('admin') then
    raise exception 'Only an Admin can publish or roll back a release.'
      using errcode = '42501';
  end if;

  -- All publish operations serialize globally; the index is the backstop.
  perform pg_catalog.pg_advisory_xact_lock(2926, 20262);
  select * into v_release from public.releases
    where id = p_release_id for update;
  if not found then
    raise exception 'Release not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.campaigns
                 where id = v_release.campaign_id and status = 'active') then
    raise exception 'Only releases of active campaigns can be published.'
      using errcode = '23514';
  end if;
  select * into v_pack from public.target_packs
    where id = v_release.target_pack_id for share;
  if v_pack.status is distinct from 'verified' or not exists (
    select 1 from public.cms_trusted_pack_checks ck
    where ck.pack_id = v_pack.id
      and ck.sha256 = v_pack.sha256
      and ck.verifier_version = 'mind-ar@1.2.5'
  ) then
    raise exception 'This release needs a verified pack checked by the trusted backend.'
      using errcode = '23514';
  end if;

  if v_release.status = 'published' and exists (
    select 1 from public.campaigns
    where id = v_release.campaign_id and live_release_id = p_release_id
  ) then
    return p_release_id;
  end if;

  -- Preserve published_at on older snapshots; enables genuine rollback.
  update public.releases
     set status = 'superseded'
   where status = 'published' and id <> p_release_id;
  update public.campaigns
     set live_release_id = null
   where live_release_id is not null;

  update public.releases
     set status = 'published',
         published_at = coalesce(published_at, now()),
         published_by = v_actor
   where id = p_release_id;

  update public.campaigns
     set live_release_id = p_release_id
   where id = v_release.campaign_id;

  return p_release_id;
end
$$;

-- The trigger functions are SECURITY INVOKER so current_user is
-- authenticated for direct API updates, and the function owner for publish.
create or replace function public.cms_guard_campaign()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.live_release_id is not null)
     or (tg_op = 'UPDATE' and new.live_release_id is distinct from old.live_release_id) then
    if current_user <> (
       select pg_catalog.pg_get_userbyid(proowner)
       from pg_catalog.pg_proc
       where oid = 'public.cms_publish_release(uuid)'::regprocedure
    ) then
      raise exception 'The live release can only change through cms_publish_release.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

create or replace function public.cms_guard_release()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.campaign_id is distinct from old.campaign_id
     or new.version is distinct from old.version
     or new.target_pack_id is distinct from old.target_pack_id
     or new.manifest is distinct from old.manifest
     or new.preview_token is distinct from old.preview_token
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'A release is immutable. Create a new release instead.'
      using errcode = '23514';
  end if;

  if (new.status, new.published_at, new.published_by)
     is distinct from (old.status, old.published_at, old.published_by) then
    if current_user <> (
       select pg_catalog.pg_get_userbyid(proowner)
       from pg_catalog.pg_proc
       where oid = 'public.cms_publish_release(uuid)'::regprocedure
    ) then
      raise exception 'Publish fields can only change through cms_publish_release.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

-- Editors cannot inject an arbitrary JSON manifest. Only the trusted
-- SECURITY DEFINER builder below creates snapshots.
drop policy if exists releases_insert on public.releases;
drop policy if exists releases_update on public.releases;
drop policy if exists releases_delete on public.releases;

create function public.cms_create_release(p_pack_id uuid, p_notes text default '')
returns public.releases language plpgsql security definer set search_path = ''
as $$
declare
  v_pack public.target_packs;
  v_campaign public.campaigns;
  v_item record;
  v_layer record;
  v_items_count integer := 0;
  v_artworks jsonb := '[]'::jsonb;
  v_layers jsonb;
  v_layer_json jsonb;
  v_manifest jsonb;
  v_release public.releases;
  v_release_id uuid := gen_random_uuid();
  v_version integer;
  v_now timestamptz := now();
begin
  if not public.cms_has_role('editor') then
    raise exception 'Only an Editor or Admin can create a release.'
      using errcode = '42501';
  end if;
  if p_pack_id is null then
    raise exception 'Choose a target pack.' using errcode = '22023';
  end if;
  if length(coalesce(p_notes, '')) > 2000 then
    raise exception 'Release notes must be 2000 characters or fewer.'
      using errcode = '22023';
  end if;

  -- Lock the campaign to serialize release version assignment.
  select c.* into v_campaign from public.campaigns c
    join public.target_packs p on p.campaign_id = c.id
    where p.id = p_pack_id for update of c;
  if not found then
    raise exception 'Campaign or target pack not found.' using errcode = 'P0002';
  end if;
  if v_campaign.status <> 'active' then
    raise exception 'Cannot release an archived campaign.' using errcode = '23514';
  end if;

  select * into v_pack from public.target_packs where id = p_pack_id for share;
  if v_pack.status is distinct from 'verified'
     or v_pack.compiler_version <> '1.2.5'
     or v_pack.storage_provider <> 'supabase'
     or v_pack.bucket <> 'ar-media'
     or not exists (
       select 1 from public.cms_trusted_pack_checks ck
       where ck.pack_id = v_pack.id
         and ck.sha256 = v_pack.sha256
         and ck.verifier_version = 'mind-ar@1.2.5'
     ) then
    raise exception 'This pack must pass trusted MindAR verification first.'
      using errcode = '23514';
  end if;

  -- Source index and dimensions are frozen in target_pack_items, not
  -- recalculated from today's Ready/Draft artwork order.
  for v_item in
    select i.*, a.name
      from public.target_pack_items i
      join public.artworks a on a.id = i.artwork_id
     where i.pack_id = p_pack_id
     order by i.target_index
  loop
    if v_item.target_index <> v_items_count then
      raise exception 'Pack indices must be contiguous, starting from zero.'
        using errcode = '23514';
    end if;
    v_items_count := v_items_count + 1;
    v_layers := '[]'::jsonb;

    for v_layer in
      select l.layer_type, l.media_id, l.scale,
             l.position_x, l.position_y, l.position_z,
             l.rotation_x, l.rotation_y, l.rotation_z,
             l.fit, l."loop" as layer_loop, l.muted as layer_muted,
             m.type as media_type, m.status as media_status,
             m.video_mode as media_video_mode,
             m.storage_provider as media_provider,
             m.bucket as media_bucket, m.storage_key as media_key
        from public.artwork_layers l
        join public.media m on m.id = l.media_id
       where l.artwork_id = v_item.artwork_id and l.enabled
       order by l.sort_order, l.created_at, l.id
    loop
      if v_layer.media_status <> 'active'
         or v_layer.media_type <> v_layer.layer_type
         or v_layer.media_provider <> 'supabase'
         or v_layer.media_bucket <> 'ar-media' then
        raise exception 'An enabled layer uses unsupported or archived media.'
          using errcode = '23514';
      end if;

      v_layer_json := jsonb_build_object(
        'type', v_layer.layer_type,
        'mediaId', v_layer.media_id,
        'asset', jsonb_build_object(
          'provider', v_layer.media_provider,
          'bucket', v_layer.media_bucket,
          'key', v_layer.media_key
        ),
        'scale', v_layer.scale,
        'position', jsonb_build_array(
          v_layer.position_x, v_layer.position_y, v_layer.position_z
        )
      );

      if v_layer.layer_type = 'VIDEO' then
        if v_layer.media_video_mode not in ('normal', 'alpha-packed')
           or v_layer.fit not in ('target', 'video') then
          raise exception 'Invalid video layer.' using errcode = '23514';
        end if;
        v_layer_json := v_layer_json || jsonb_build_object(
          'videoMode', v_layer.media_video_mode,
          'fit', v_layer.fit,
          'loop', v_layer.layer_loop,
          'muted', v_layer.layer_muted
        );
      elsif v_layer.layer_type = 'MODEL_3D' then
        v_layer_json := v_layer_json || jsonb_build_object(
          'rotation', jsonb_build_array(
            v_layer.rotation_x, v_layer.rotation_y, v_layer.rotation_z
          )
        );
      else
        raise exception 'Unsupported layer type.' using errcode = '23514';
      end if;

      v_layers := v_layers || jsonb_build_array(v_layer_json);
    end loop;

    v_artworks := v_artworks || jsonb_build_array(jsonb_build_object(
      'id', v_item.artwork_id,
      'name', v_item.name,
      'targetIndex', v_item.target_index,
      'targetWidth', v_item.width,
      'targetHeight', v_item.height,
      'layers', v_layers
    ));
  end loop;

  if v_items_count <> v_pack.target_count then
    raise exception 'Target pack contains an incomplete item mapping.'
      using errcode = '23514';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
    from public.releases where campaign_id = v_campaign.id;

  v_manifest := jsonb_build_object(
    'schemaVersion', 1,
    'campaignId', v_campaign.id,
    'campaignSlug', v_campaign.slug,
    'releaseId', v_release_id,
    'version', v_version,
    'createdAt', v_now,
    'rotateMatchOrder', v_campaign.rotate_match_order,
    'targetPack', jsonb_build_object(
      'id', v_pack.id, 'version', v_pack.version,
      'asset', jsonb_build_object(
        'provider', v_pack.storage_provider,
        'bucket', v_pack.bucket,
        'key', v_pack.storage_key
      ),
      'sha256', v_pack.sha256,
      'targetCount', v_pack.target_count,
      'compilerVersion', v_pack.compiler_version
    ),
    'artworks', v_artworks
  );

  insert into public.releases (
    id, campaign_id, version, target_pack_id, manifest, notes
  ) values (
    v_release_id, v_campaign.id, v_version, p_pack_id,
    v_manifest, coalesce(p_notes, '')
  ) returning * into v_release;

  return v_release;
end
$$;

-- Do not permit direct RPC access to the stored verified check.
-- Public scanner reads only the manifest selected by the live pointer.
create function public.cms_get_live_manifest()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select r.manifest from public.campaigns c
    join public.releases r on r.id = c.live_release_id
   where c.status = 'active' and r.status = 'published'
   limit 1
$$;

-- Preview is private to logged-in CMS members. A token alone never grants
-- anonymous access to the manifest or private CMS tables.
create function public.cms_get_preview_manifest(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_manifest jsonb;
begin
  if not public.cms_has_role('viewer') then
    raise exception 'Sign in to the CMS to preview a release.'
      using errcode = '42501';
  end if;
  select manifest into v_manifest
    from public.releases where preview_token = p_token;
  return v_manifest;
end
$$;

revoke all on function public.cms_create_release(uuid,text) from public, anon;
revoke all on function public.cms_publish_release(uuid) from public, anon;
revoke all on function public.cms_get_live_manifest() from public;
revoke all on function public.cms_get_preview_manifest(uuid) from public, anon;
grant execute on function public.cms_create_release(uuid,text) to authenticated;
grant execute on function public.cms_publish_release(uuid) to authenticated;
grant execute on function public.cms_get_live_manifest() to anon, authenticated;
grant execute on function public.cms_get_preview_manifest(uuid) to authenticated;

comment on table public.cms_trusted_pack_checks is
  'Private attestation inserted only by the trusted Edge Function after downloading, hashing and parsing the actual stored MindAR file. Not writable by CMS clients.';
comment on function public.cms_publish_release(uuid) is
  'Atomically publishes or rolls back a single site-wide release. Admin only. Trusted pack attestation required.';
comment on function public.cms_create_release(uuid,text) is
  'Builds an immutable release JSON manifest entirely in Postgres from pack items and working layers. Editor or Admin only.';

-- Built-in postflight. Any privilege drift aborts the whole migration.
do $$
begin
  if has_function_privilege('anon', 'public.cms_create_release(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.cms_publish_release(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.cms_get_preview_manifest(uuid)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.cms_trusted_pack_checks', 'INSERT')
     or has_table_privilege('authenticated', 'public.cms_trusted_pack_checks', 'UPDATE')
     or not has_function_privilege('anon', 'public.cms_get_live_manifest()', 'EXECUTE') then
    raise exception 'Phase 2C.2 security postflight failed; transaction rolled back.';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'releases'
      and cmd in ('INSERT','UPDATE','DELETE','ALL')
  ) then
    raise exception 'Release direct-write policies remain; transaction rolled back.';
  end if;
end
$$;

commit;
