-- EMERGENCY ONLY. Undoes migration 20261013120300_cms_hardening.sql and
-- restores the permissive access that existed before it. Files 1-3 stay.
--
-- The original storage policy names were not recorded, so the restored
-- storage policies get new names with the same effect.

begin;

drop policy if exists cms_ar_content_insert on public.ar_content;
drop policy if exists cms_ar_content_update on public.ar_content;

create policy "Authenticated can insert AR config" on public.ar_content
  for insert to authenticated
  with check (true);

create policy "Authenticated can update AR config" on public.ar_content
  for update to authenticated
  using (true)
  with check (true);

drop policy if exists cms_scanner_objects_insert on storage.objects;
drop policy if exists cms_scanner_objects_delete on storage.objects;

create policy "Authenticated can insert ar-assets" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'ar-assets');

create policy "Authenticated can update ar-assets" on storage.objects
  for update to authenticated
  using (bucket_id = 'ar-assets')
  with check (bucket_id = 'ar-assets');

create policy "Authenticated can delete ar-assets" on storage.objects
  for delete to authenticated
  using (bucket_id = 'ar-assets');

commit;
