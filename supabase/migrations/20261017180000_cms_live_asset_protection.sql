-- Phase 2C.4 M3: protect the files the live scanner uses; harden ar-assets.
-- STAGING FIRST. Apply after 20261017120000 (M1). One transaction.
-- No temp tables, so it behaves the same in the SQL Editor and in psql.
--
-- PROBLEMS
--   1. A release manifest names its files by storage key; no foreign key ties
--      the key to the object. cms_media_objects_delete lets an Admin delete
--      any ar-media object, so one delete (or a stolen Admin session) breaks
--      the LIVE scanner, or the superseded release a rollback republishes.
--      Target pack files are already protected (Phase 2B); media files are not.
--   2. An Admin can delete a media row that a release names once no working
--      layer uses it any more, losing the record of what the release used.
--   3. ar-assets (legacy, public) has no type allowlist, no size limit and no
--      path rule: an Editor can store HTML or SVG under scanner/, served from
--      the project's storage domain. Scanner Settings accepted image/*,
--      which includes SVG.
--   4. cms_scanner_objects_delete lets an Admin delete the scanner assets the
--      published ar_content config points at.
--
-- FIX
--   1. RESTRICTIVE delete and update policies: an object named in ANY release
--      manifest (preview, published or superseded) cannot be deleted, renamed
--      or overwritten through the API, in any bucket.
--   2. A trigger refuses deleting a media row that a release names.
--   3. ar-assets accepts only image/png, image/jpeg, image/webp, video/mp4 and
--      video/webm, at most 50 MB. A new object must be
--      scanner/{asset}/{sha256}.{png|jpg|webp|mp4|webm}. RESTRICTIVE insert
--      and update guards for ar-assets. (Keep equal to src/cms/mediaRules.ts.)
--   4. RESTRICTIVE delete policy: an ar-assets object that any ar_content
--      config value points at cannot be deleted.
--
-- WHAT IT DOES NOT DO
--   No stored object, release, manifest, media row or ar_content value is
--   changed. Existing ar-assets objects (the legacy live/ files, any type)
--   stay where they are and are served as before; the limits apply to new
--   uploads. ar-media and ar-sources settings are not touched.
--   The service role (Dashboard, SQL editor) bypasses row level security:
--   these guards stop API users, including Admins, not database operators.
--   Storage checks the type an upload declares, not its bytes.
--
-- ROLLBACK (the preflight NOTICE prints the previous ar-assets settings)
--   drop policy cms_released_objects_protect on storage.objects;
--   drop policy cms_released_objects_update_guard on storage.objects;
--   drop policy cms_live_scanner_assets_protect on storage.objects;
--   drop policy cms_ar_assets_path_guard on storage.objects;
--   drop policy cms_ar_assets_rename_guard on storage.objects;
--   drop trigger cms_guard_media_delete on public.media;
--   drop function public.cms_guard_media_delete();
--   drop function public.cms_is_released_object(text, text);
--   drop function public.cms_is_live_scanner_asset(text, text);
--   drop function public.cms_ar_assets_path_kind(text);
--   update storage.buckets set allowed_mime_types = <previous>,
--     file_size_limit = <previous> where id = 'ar-assets';

begin;

-- ================================================================ preflight

do $$
declare
  v_assets storage.buckets;
begin
  select * into v_assets from storage.buckets where id = 'ar-assets';
  if not found or not v_assets.public then
    raise exception 'The public ar-assets bucket is missing. Nothing was changed.';
  end if;

  if not exists (select 1 from storage.buckets where id = 'ar-media' and public) then
    raise exception 'The public ar-media bucket is missing. Nothing was changed.';
  end if;

  if to_regprocedure('public.cms_ar_media_path_kind(text)') is null
     or to_regprocedure('public.cms_publish_release(uuid)') is null
     or to_regprocedure('public.cms_has_role(text)') is null then
    raise exception 'Phase 2C.2 and M1 must be installed first. Nothing was changed.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ar_content'
       and column_name = 'config' and data_type = 'jsonb'
  ) then
    raise exception 'public.ar_content.config (jsonb) is missing. Nothing was changed.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'cms_scanner_objects_insert'
  ) then
    raise exception 'cms_scanner_objects_insert is missing. Nothing was changed.';
  end if;

  raise notice 'Previous ar-assets settings (for rollback): file_size_limit=%, allowed_mime_types=%',
    coalesce(v_assets.file_size_limit::text, 'null'),
    coalesce(v_assets.allowed_mime_types::text, 'null');
end;
$$;

-- ============================================================== functions

-- True when any release manifest names this object: as a layer asset or as
-- its target pack. Every status counts: a superseded release is what a
-- rollback republishes, and a preview may be published.
create or replace function public.cms_is_released_object(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.releases r
     where r.manifest @> jsonb_build_object('artworks', jsonb_build_array(
             jsonb_build_object('layers', jsonb_build_array(
               jsonb_build_object('asset', jsonb_build_object('bucket', p_bucket, 'key', p_name))))))
        or r.manifest @> jsonb_build_object('targetPack',
             jsonb_build_object('asset', jsonb_build_object('bucket', p_bucket, 'key', p_name)))
  );
$$;

-- True when an ar_content config value is the public URL of this ar-assets
-- object. Compared as a suffix, so no character of the name is a pattern.
create or replace function public.cms_is_live_scanner_asset(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_bucket = 'ar-assets' and exists (
    select 1
      from public.ar_content c,
           jsonb_each_text(case when jsonb_typeof(c.config) = 'object' then c.config else '{}'::jsonb end) v
     where right(v.value, length('/storage/v1/object/public/ar-assets/' || p_name))
           = '/storage/v1/object/public/ar-assets/' || p_name
  );
$$;

-- 'scanner' for scanner/{asset}/{sha256}.{ext}, NULL for anything else.
create or replace function public.cms_ar_assets_path_kind(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^scanner/[A-Za-z][A-Za-z0-9]{0,63}/[0-9a-f]{64}\.(png|jpg|webp|mp4|webm)$'
      then 'scanner'
  end
$$;

-- A media row that a release names is a permanent record. Archive it instead.
create or replace function public.cms_guard_media_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.cms_is_released_object(old.bucket, old.storage_key)
     or exists (
       select 1
         from public.releases r
        where r.manifest @> jsonb_build_object('artworks', jsonb_build_array(
                jsonb_build_object('layers', jsonb_build_array(
                  jsonb_build_object('mediaId', old.id)))))
     ) then
    raise exception 'This media file is used by a release and cannot be deleted. Archive it instead.'
      using errcode = '23514';
  end if;
  return old;
end;
$$;

drop trigger if exists cms_guard_media_delete on public.media;
create trigger cms_guard_media_delete before delete on public.media
  for each row execute function public.cms_guard_media_delete();

revoke all on function public.cms_is_released_object(text, text) from public;
revoke all on function public.cms_is_live_scanner_asset(text, text) from public;
revoke all on function public.cms_ar_assets_path_kind(text) from public;
revoke all on function public.cms_guard_media_delete() from public, anon, authenticated;
-- Storage policies run as the requesting role.
grant execute on function public.cms_is_released_object(text, text) to anon, authenticated;
grant execute on function public.cms_is_live_scanner_asset(text, text) to anon, authenticated;
grant execute on function public.cms_ar_assets_path_kind(text) to anon, authenticated;

-- ================================================================ bucket

update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']
 where id = 'ar-assets';

-- ============================================================== policies

drop policy if exists cms_released_objects_protect on storage.objects;
create policy cms_released_objects_protect on storage.objects
  as restrictive
  for delete to public
  using (not public.cms_is_released_object(bucket_id, name));

drop policy if exists cms_released_objects_update_guard on storage.objects;
create policy cms_released_objects_update_guard on storage.objects
  as restrictive
  for update to public
  using (not public.cms_is_released_object(bucket_id, name))
  with check (not public.cms_is_released_object(bucket_id, name));

drop policy if exists cms_live_scanner_assets_protect on storage.objects;
create policy cms_live_scanner_assets_protect on storage.objects
  as restrictive
  for delete to public
  using (not public.cms_is_live_scanner_asset(bucket_id, name));

drop policy if exists cms_ar_assets_path_guard on storage.objects;
create policy cms_ar_assets_path_guard on storage.objects
  as restrictive
  for insert to public
  with check (
    bucket_id is distinct from 'ar-assets'
    or public.cms_ar_assets_path_kind(name) is not null
  );

drop policy if exists cms_ar_assets_rename_guard on storage.objects;
create policy cms_ar_assets_rename_guard on storage.objects
  as restrictive
  for update to public
  using (
    bucket_id is distinct from 'ar-assets'
    or public.cms_ar_assets_path_kind(name) is not null
  )
  with check (
    bucket_id is distinct from 'ar-assets'
    or public.cms_ar_assets_path_kind(name) is not null
  );

-- =============================================================== postflight

do $$
declare
  v_bucket   storage.buckets;
  v_count    bigint;
  v_sha      text := repeat('a', 64);
  v_name     text;
  v_manifest jsonb;
begin
  select * into v_bucket from storage.buckets where id = 'ar-assets';
  if not v_bucket.public
     or v_bucket.file_size_limit is distinct from 52428800
     or (select array_agg(t order by t) from unnest(v_bucket.allowed_mime_types) t)
        is distinct from array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'] then
    raise exception 'ar-assets bucket settings are not as intended. Rolled back.';
  end if;

  -- M1 must be untouched.
  select * into v_bucket from storage.buckets where id = 'ar-media';
  if v_bucket.file_size_limit is distinct from 52428800
     or (select array_agg(t order by t) from unnest(v_bucket.allowed_mime_types) t)
        is distinct from array['application/octet-stream', 'image/jpeg', 'image/png',
                               'image/webp', 'model/gltf-binary', 'video/mp4', 'video/webm'] then
    raise exception 'ar-media settings changed. Rolled back.';
  end if;

  -- The path rule, on names the CMS writes and names it must refuse.
  foreach v_name in array array['png', 'jpg', 'webp', 'mp4', 'webm'] loop
    if public.cms_ar_assets_path_kind(format('scanner/scannerBorder/%s.%s', v_sha, v_name))
       is distinct from 'scanner' then
      raise exception 'Path rule refuses a valid .% scanner asset. Rolled back.', v_name;
    end if;
  end loop;
  foreach v_name in array array[
    format('scanner/scannerBorder/%s.svg', v_sha),
    format('scanner/scannerBorder/%s.html', v_sha),
    format('scanner/scannerBorder/%s.gif', v_sha),
    format('scanner/scannerBorder/%s.mov', v_sha),
    format('scanner/scannerBorder/%s.PNG', v_sha),
    format('scanner/scannerBorder/%s.png.html', v_sha),
    format('scanner/scannerBorder/x/%s.png', v_sha),
    format('scanner/scanner-border/%s.png', v_sha),
    format('scanner/1border/%s.png', v_sha),
    format('scanner/%s.png', v_sha),
    format('scanner/../%s.png', v_sha),
    format('live/%s.png', v_sha),
    'index.html'
  ] loop
    if public.cms_ar_assets_path_kind(v_name) is not null then
      raise exception 'Path rule accepts the invalid name %. Rolled back.', v_name;
    end if;
  end loop;

  if exists (
    select 1 from pg_catalog.pg_proc
     where oid in ('public.cms_is_released_object(text,text)'::regprocedure,
                   'public.cms_is_live_scanner_asset(text,text)'::regprocedure)
       and (not prosecdef or provolatile <> 's')
  ) or exists (
    select 1 from pg_catalog.pg_proc
     where oid = 'public.cms_ar_assets_path_kind(text)'::regprocedure
       and (prosecdef or provolatile <> 'i')
  ) then
    raise exception 'Function security or volatility is not as intended. Rolled back.';
  end if;

  select count(*) into v_count from pg_catalog.pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and permissive = 'RESTRICTIVE'
     and policyname in ('cms_released_objects_protect', 'cms_released_objects_update_guard',
                        'cms_live_scanner_assets_protect', 'cms_ar_assets_path_guard',
                        'cms_ar_assets_rename_guard',
                        'cms_ar_media_objects_path_guard', 'cms_ar_media_objects_rename_guard',
                        'cms_pack_objects_insert_guard', 'cms_pack_objects_update_guard',
                        'cms_pack_objects_protect');
  if v_count <> 10 then
    raise exception 'Expected 10 restrictive storage policies, found %. Rolled back.', v_count;
  end if;

  if exists (
    select 1 from pg_catalog.pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and permissive = 'PERMISSIVE'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       and ('anon' = any (roles) or 'public' = any (roles))
  ) then
    raise exception 'A storage policy allows anonymous writes. Rolled back.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger
     where tgrelid = 'public.media'::regclass and tgname = 'cms_guard_media_delete' and not tgisinternal
  ) then
    raise exception 'The media delete guard is missing. Rolled back.';
  end if;

  -- On real data: every file of the live release must now be protected.
  select r.manifest into v_manifest
    from public.campaigns c join public.releases r on r.id = c.live_release_id
   where r.status = 'published'
   limit 1;
  if v_manifest is not null then
    if not public.cms_is_released_object(v_manifest #>> '{targetPack,asset,bucket}',
                                         v_manifest #>> '{targetPack,asset,key}') then
      raise exception 'The live target pack is not reported as released. Rolled back.';
    end if;
    select count(*) into v_count
      from jsonb_array_elements(v_manifest -> 'artworks') a,
           jsonb_array_elements(a -> 'layers') l
     where not public.cms_is_released_object(l #>> '{asset,bucket}', l #>> '{asset,key}');
    if v_count > 0 then
      raise exception '% live layer file(s) are not reported as released. Rolled back.', v_count;
    end if;
    raise notice 'Live release files are protected: % layer file(s) and the target pack.',
      (select count(*) from jsonb_array_elements(v_manifest -> 'artworks') a,
                            jsonb_array_elements(a -> 'layers') l);
  else
    raise notice 'No live release; nothing to cross-check.';
  end if;

  -- Reported, never changed.
  select count(*) into v_count from storage.objects
   where bucket_id = 'ar-assets' and public.cms_is_live_scanner_asset(bucket_id, name);
  raise notice '% ar-assets object(s) are used by ar_content and now protected from deletion.', v_count;

  select count(*) into v_count from storage.objects
   where bucket_id = 'ar-assets' and public.cms_ar_assets_path_kind(name) is null;
  if v_count > 0 then
    raise notice '% existing ar-assets object(s) have a name the new path rule would refuse (legacy files). They are not changed.', v_count;
  end if;

  select count(*) into v_count from storage.objects
   where bucket_id = 'ar-assets'
     and coalesce(metadata ->> 'mimetype', '') <> all
         (array['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']);
  if v_count > 0 then
    raise notice '% existing ar-assets object(s) have a type outside the new allowlist. They are not changed.', v_count;
  end if;
end;
$$;

commit;
