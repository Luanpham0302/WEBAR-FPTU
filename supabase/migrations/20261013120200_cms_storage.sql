-- Phase 2A, file 3 of 3: storage buckets and storage policies for the CMS.
--
-- Requires file 2. Creates two NEW buckets. The existing ar-assets bucket and
-- its policies are not touched.
--
--   ar-media    public   media/{media-id}/{sha256}.{ext}
--   ar-sources  private  triggers/{campaign-id}/{artwork-id}/{sha256}.{ext}
--
-- Neither bucket gets an UPDATE policy, so a stored file can never be
-- overwritten. A new version is always a new path.

begin;

insert into storage.buckets (id, name, public)
values ('ar-media', 'ar-media', true)
on conflict (id) do nothing;

-- Trigger source images: private, images only, 20 MB each.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ar-sources', 'ar-sources', false, 20971520,
  array['image/png', 'image/jpeg']
)
on conflict (id) do nothing;

-- ---- ar-media
-- Visitors read through the public URL, which needs no policy. This select
-- policy only lets CMS users list and inspect objects.
create policy cms_media_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ar-media'
    and (select public.cms_has_role('viewer'))
  );
create policy cms_media_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ar-media'
    and (storage.foldername(name))[1] = 'media'
    and (select public.cms_has_role('editor'))
  );
-- Administrative cleanup only.
create policy cms_media_objects_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ar-media'
    and (select public.cms_has_role('admin'))
  );

-- ---- ar-sources
-- The bucket is private, so this policy is the only way to read a trigger
-- source: a signed-in CMS user, through a signed URL or an authenticated
-- download. Scanner visitors never need these files.
create policy cms_source_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ar-sources'
    and (select public.cms_has_role('viewer'))
  );
create policy cms_source_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ar-sources'
    and (storage.foldername(name))[1] = 'triggers'
    and (select public.cms_has_role('editor'))
  );
create policy cms_source_objects_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ar-sources'
    and (select public.cms_has_role('admin'))
  );

commit;
