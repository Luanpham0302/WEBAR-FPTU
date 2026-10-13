-- Phase 2A, file 4 of 4: tighten the EXISTING ar_content table and ar-assets
-- bucket. This is the only file that changes anything that exists today.
--
-- Requires files 1-3 AND a first Admin in user_roles: after this file, only
-- a CMS Admin can publish Scanner Settings.
--
-- Deploy the new frontend BEFORE applying this file. The old admin page
-- overwrote ar-assets/live/*, which this file no longer allows.
--
-- Unchanged on purpose:
--   - "Public can read AR config"  (the scanner reads ar_content with it)
--   - the public SELECT policy on ar-assets objects
--   - every stored file, including the legacy live/ files
--   - the ar-assets bucket itself (still public, same URLs)
--
-- One transaction. If any check below fails, nothing is changed.

begin;

-- Without an Admin, nobody could publish Scanner Settings after this file.
do $$
begin
  if not exists (select 1 from public.user_roles where role = 'admin') then
    raise exception
      'No Admin exists in user_roles. Run supabase/manual/02_first_admin.sql first. Nothing was changed.';
  end if;
end;
$$;

-- ============================================================== ar_content
-- Before: any signed-in user could insert and update the live config.
-- After:  only a CMS Admin can. No DELETE policy is added, so nobody can
--         delete the row through the API.

drop policy if exists "Authenticated can insert AR config" on public.ar_content;
drop policy if exists "Authenticated can update AR config" on public.ar_content;

create policy cms_ar_content_insert on public.ar_content
  for insert to authenticated
  with check ((select public.cms_has_role('admin')));

create policy cms_ar_content_update on public.ar_content
  for update to authenticated
  using ((select public.cms_has_role('admin')))
  with check ((select public.cms_has_role('admin')));

-- Stop if the result is not exactly what was intended. DROP ... IF EXISTS
-- skips silently when a name differs, which would leave a broad policy alive.
do $$
declare
  v_extra text;
begin
  select string_agg(format('%I (%s)', policyname, cmd), ', ')
    into v_extra
    from pg_policies
   where schemaname = 'public'
     and tablename = 'ar_content'
     and cmd <> 'SELECT'
     and policyname not in ('cms_ar_content_insert', 'cms_ar_content_update');

  if v_extra is not null then
    raise exception
      'ar_content still has other write policies: %. Nothing was changed.', v_extra;
  end if;

  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'ar_content'
       and cmd = 'SELECT'
       and ('anon' = any (roles) or 'public' = any (roles))
  ) then
    raise exception
      'ar_content has no public read policy; the scanner would break. Nothing was changed.';
  end if;
end;
$$;

-- ================================================ ar-assets storage objects
-- Before: any signed-in user could insert, UPDATE (overwrite) and delete any
--         object in ar-assets.
-- After:  Editor and Admin can add new files under scanner/ only. Nobody can
--         overwrite. Only an Admin can delete, and only under scanner/.
--         The legacy live/ files can no longer be changed or removed through
--         the API, and stay readable at their current public URLs.

-- The audit gave the effect of the old policies, not their names, so they
-- are found by what they do: every INSERT / UPDATE / DELETE policy on
-- storage.objects whose expression names the ar-assets bucket. Each dropped
-- name is printed. Run supabase/manual/03_preview_hardening.sql first to see
-- the same list without changing anything.
do $$
declare
  v_policy record;
  v_all    text;
begin
  -- A FOR ALL policy would also carry read access. Do not guess: stop.
  select string_agg(format('%I', policyname), ', ')
    into v_all
    from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and cmd = 'ALL'
     and policyname not like 'cms\_%'
     and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%ar-assets%';

  if v_all is not null then
    raise exception
      'FOR ALL policies on ar-assets need a manual decision: %. Nothing was changed.', v_all;
  end if;

  for v_policy in
    select policyname, cmd
      from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
       and policyname not like 'cms\_%'
       and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%ar-assets%'
     order by policyname
  loop
    execute format('drop policy %I on storage.objects', v_policy.policyname);
    raise notice 'Dropped storage policy % (%)', v_policy.policyname, v_policy.cmd;
  end loop;
end;
$$;

-- Scanner assets: scanner/{asset-key}/{sha256}.{ext}. New files only.
create policy cms_scanner_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ar-assets'
    and (storage.foldername(name))[1] = 'scanner'
    and (select public.cms_has_role('editor'))
  );

-- No UPDATE policy: a stored scanner asset is immutable.

-- Administrative cleanup, never under live/.
create policy cms_scanner_objects_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ar-assets'
    and (storage.foldername(name))[1] = 'scanner'
    and (select public.cms_has_role('admin'))
  );

-- Report any other write policy on storage.objects that is not ours. A
-- policy that does not name a bucket (for example WITH CHECK (true)) would
-- still let people write to ar-assets, and cannot be detected by name.
do $$
declare
  v_other text;
begin
  select string_agg(format('%I (%s)', policyname, cmd), ', ')
    into v_other
    from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and cmd <> 'SELECT'
     and policyname not like 'cms\_%';

  if v_other is not null then
    raise warning
      'Other write policies remain on storage.objects, review them: %', v_other;
  end if;
end;
$$;

commit;
