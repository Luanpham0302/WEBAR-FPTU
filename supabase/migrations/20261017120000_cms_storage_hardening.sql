-- Phase 2C.4 security fix M1: harden the public ar-media bucket.
-- STAGING FIRST. Apply after 20261017090000. One transaction.
--
-- PROBLEM
--   ar-media is public and had no allowed_mime_types and no file_size_limit.
--   cms_media_objects_insert let an Editor store any file under media/,
--   with any name and any declared type. Anything there is served from the
--   project's storage domain with the type the uploader declared, so an
--   Editor (or a stolen Editor session) could publish HTML or SVG pages.
--
-- FIX (three independent layers)
--   1. Bucket: ar-media accepts only the types WebAR uses and at most 50 MB.
--      Storage enforces this on every upload, before anything is stored.
--   2. Path: a media object must be media/{uuid}/{sha256}.{mp4|webm|glb|
--      png|jpg|webp}. cms_media_objects_insert is replaced with that rule.
--   3. Backstop: two RESTRICTIVE policies refuse any ar-media insert, and
--      any ar-media update whose current or new name is neither such a
--      media path nor a target pack path. A permissive policy added later,
--      or one left over from before, cannot reopen the bucket.
--   Target pack uploads keep their Phase 2B rules unchanged: an Editor can
--   only upload to the exact path of a pack they reserved.
--
-- MIME TYPES (keep equal to src/cms/mediaRules.ts)
--   video/mp4, video/webm            videos
--   model/gltf-binary                3D models (.glb)
--   image/png, image/jpeg, image/webp  Media Library images
--   application/octet-stream         target packs (.mind); also what a
--                                    browser sends for a .glb with no type
--   Not allowed: text/html, image/svg+xml, video/quicktime, everything else.
--
-- WHAT IT DOES NOT DO
--   Storage checks the type the uploader DECLARES, not the bytes. A file
--   whose bytes are not what its type says is still accepted; it is only
--   ever served with an allowed type. No byte check exists for media.
--   It does not touch any stored object: the limits apply to new uploads.
--   It does not touch ar-assets, ar-sources, any table, row or other policy.
--
-- ROLLBACK
--   update storage.buckets set file_size_limit = null,
--     allowed_mime_types = null where id = 'ar-media';
--   drop policy cms_ar_media_objects_path_guard on storage.objects;
--   drop policy cms_ar_media_objects_rename_guard on storage.objects;
--   re-create cms_media_objects_insert from 20261013120200;
--   drop function public.cms_ar_media_path_kind(text);

begin;

-- ================================================================ preflight

-- Every other bucket, whole rows, to prove below that none was changed,
-- added or removed.
create temp table cms_m1_other_buckets on commit drop as
  select to_jsonb(b) as bucket
    from storage.buckets b
   where b.id <> 'ar-media';

do $$
declare
  v_problem text;
begin
  if not exists (select 1 from storage.buckets where id = 'ar-media' and public) then
    raise exception 'The public ar-media bucket is missing. Nothing was changed.';
  end if;

  if to_regprocedure('public.cms_has_role(text)') is null
     or to_regprocedure('public.cms_pack_max_bytes()') is null
     or to_regprocedure('public.cms_is_reserved_pack_object(text,text)') is null then
    raise exception 'Phase 2A and 2B must be installed first. Nothing was changed.';
  end if;

  if public.cms_pack_max_bytes() > 52428800 then
    raise exception 'cms_pack_max_bytes() is above 50 MB; the bucket limit would refuse packs. Nothing was changed.';
  end if;

  select string_agg(expected.name, ', ')
    into v_problem
    from (values ('cms_media_objects_insert'), ('cms_target_objects_insert'),
                 ('cms_pack_objects_insert_guard'), ('cms_pack_objects_update_guard'),
                 ('cms_pack_objects_protect')) as expected (name)
    left join pg_catalog.pg_policies p
      on p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = expected.name
   where p.policyname is null;

  if v_problem is not null then
    raise exception 'Expected storage policies are missing: %. Nothing was changed.', v_problem;
  end if;
end;
$$;

-- ============================================================ path rule

-- 'media' for media/{uuid}/{sha256}.{ext}, 'target' for a target pack path,
-- NULL for anything else. Lower-case only, exactly as the CMS writes keys.
create or replace function public.cms_ar_media_path_kind(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.(mp4|webm|glb|png|jpg|webp)$'
      then 'media'
    when p_name ~ '^targets/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/v[1-9][0-9]{0,8}/targets\.mind$'
      then 'target'
  end
$$;

revoke all on function public.cms_ar_media_path_kind(text) from public;
-- Storage policies run as the uploading role.
grant execute on function public.cms_ar_media_path_kind(text) to anon, authenticated;

-- ================================================================ bucket

update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array[
         'video/mp4', 'video/webm',
         'model/gltf-binary',
         'image/png', 'image/jpeg', 'image/webp',
         'application/octet-stream'
       ]
 where id = 'ar-media';

-- ============================================================== policies

-- Phase 2A allowed any name under media/. Same roles, stricter name.
drop policy cms_media_objects_insert on storage.objects;
create policy cms_media_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ar-media'
    and public.cms_ar_media_path_kind(name) = 'media'
    and (select public.cms_has_role('editor'))
  );

drop policy if exists cms_ar_media_objects_path_guard on storage.objects;
create policy cms_ar_media_objects_path_guard on storage.objects
  as restrictive
  for insert to public
  with check (
    bucket_id is distinct from 'ar-media'
    or public.cms_ar_media_path_kind(name) is not null
  );

drop policy if exists cms_ar_media_objects_rename_guard on storage.objects;
create policy cms_ar_media_objects_rename_guard on storage.objects
  as restrictive
  for update to public
  using (
    bucket_id is distinct from 'ar-media'
    or public.cms_ar_media_path_kind(name) is not null
  )
  with check (
    bucket_id is distinct from 'ar-media'
    or public.cms_ar_media_path_kind(name) is not null
  );

-- =============================================================== postflight

do $$
declare
  v_bucket storage.buckets;
  v_count  bigint;
  v_uuid   text := '0b9f6c1e-2f43-4c8e-9d0a-6f1f8b7a5c11';
  v_sha    text := repeat('a', 64);
  v_name   text;
begin
  select * into v_bucket from storage.buckets where id = 'ar-media';
  if v_bucket.file_size_limit is distinct from 52428800
     or v_bucket.file_size_limit < public.cms_pack_max_bytes()
     or not v_bucket.public
     or (select array_agg(t order by t) from unnest(v_bucket.allowed_mime_types) t)
        is distinct from array['application/octet-stream', 'image/jpeg', 'image/png',
                               'image/webp', 'model/gltf-binary', 'video/mp4', 'video/webm'] then
    raise exception 'ar-media bucket settings are not as intended. Rolled back.';
  end if;

  -- Both directions: a row only now is a changed or added bucket, a row only
  -- in the snapshot is a changed or removed one.
  select string_agg(distinct d.bucket ->> 'id', ', ') into v_name
    from (
      (select to_jsonb(b) as bucket from storage.buckets b where b.id <> 'ar-media'
       except
       select bucket from cms_m1_other_buckets)
      union all
      (select bucket from cms_m1_other_buckets
       except
       select to_jsonb(b) from storage.buckets b where b.id <> 'ar-media')
    ) d;
  if v_name is not null then
    raise exception 'Buckets other than ar-media were changed, added or removed: %. Rolled back.', v_name;
  end if;

  -- The path rule, on names the CMS writes and names it must refuse.
  foreach v_name in array array['mp4', 'webm', 'glb', 'png', 'jpg', 'webp'] loop
    if public.cms_ar_media_path_kind(format('media/%s/%s.%s', v_uuid, v_sha, v_name))
       is distinct from 'media' then
      raise exception 'Path rule refuses a valid .% media name. Rolled back.', v_name;
    end if;
  end loop;
  if public.cms_ar_media_path_kind(format('targets/%s/v12/targets.mind', v_uuid))
     is distinct from 'target' then
    raise exception 'Path rule refuses a valid target pack name. Rolled back.';
  end if;
  foreach v_name in array array[
    format('media/%s/%s.html', v_uuid, v_sha),
    format('media/%s/%s.svg', v_uuid, v_sha),
    format('media/%s/%s.mkv', v_uuid, v_sha),
    format('media/%s/%s.mov', v_uuid, v_sha),
    format('media/%s/%s.MP4', v_uuid, v_sha),
    format('media/%s/%s.mp4.html', v_uuid, v_sha),
    format('media/%s/%s/x.mp4', v_uuid, v_sha),
    format('media/%s/%s.mp4', upper(v_uuid), v_sha),
    format('media/%s/x.mp4', v_uuid),
    'media/x.mp4',
    format('media/../%s/%s.mp4', v_uuid, v_sha),
    format('scanner/%s/%s.mp4', v_uuid, v_sha),
    format('targets/%s/v0/targets.mind', v_uuid),
    format('targets/%s/v1/targets.html', v_uuid),
    format('targets/%s/v1/other.mind', v_uuid)
  ] loop
    if public.cms_ar_media_path_kind(v_name) is not null then
      raise exception 'Path rule accepts the invalid name %. Rolled back.', v_name;
    end if;
  end loop;

  if exists (
    select 1 from pg_catalog.pg_proc
     where oid = 'public.cms_ar_media_path_kind(text)'::regprocedure
       and (prosecdef or provolatile <> 'i')
  ) then
    raise exception 'cms_ar_media_path_kind() must be IMMUTABLE and SECURITY INVOKER. Rolled back.';
  end if;

  select count(*) into v_count from pg_catalog.pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and permissive = 'RESTRICTIVE'
     and policyname in ('cms_ar_media_objects_path_guard', 'cms_ar_media_objects_rename_guard',
                        'cms_pack_objects_insert_guard', 'cms_pack_objects_update_guard',
                        'cms_pack_objects_protect');
  if v_count <> 5 then
    raise exception 'Restrictive storage policies are missing. Rolled back.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'cms_target_objects_insert' and permissive = 'PERMISSIVE'
  ) then
    raise exception 'The target pack upload policy is missing. Rolled back.';
  end if;

  -- As in Phase 2B: no permissive policy may give anonymous visitors a write.
  if exists (
    select 1 from pg_catalog.pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and permissive = 'PERMISSIVE'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       and ('anon' = any (roles) or 'public' = any (roles))
  ) then
    raise exception 'A storage policy allows anonymous writes. Rolled back.';
  end if;

  -- Reported, never changed: stored objects that the new rules would refuse
  -- today. They stay where they are and are served as before.
  select count(*) into v_count from storage.objects
   where bucket_id = 'ar-media' and public.cms_ar_media_path_kind(name) is null;
  if v_count > 0 then
    raise notice '% existing ar-media object(s) have a name the new path rule would refuse. They are not changed.', v_count;
  end if;

  select count(*) into v_count from storage.objects
   where bucket_id = 'ar-media'
     and coalesce(metadata ->> 'mimetype', '') <> all (v_bucket.allowed_mime_types);
  if v_count > 0 then
    raise notice '% existing ar-media object(s) have a type outside the new allowlist. They are not changed.', v_count;
  end if;
end;
$$;

commit;
