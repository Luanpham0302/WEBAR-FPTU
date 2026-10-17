-- Behaviour test for 20261017120000_cms_storage_hardening.sql (M1).
--
-- Run as the postgres role (Supabase SQL editor) AFTER the migration. Every
-- statement runs in ONE transaction that always ends in ROLLBACK: the test
-- users, campaign, pack row and storage.objects rows it inserts are never
-- committed, and no file is uploaded (these are metadata rows only).
--
-- It checks the row level security of storage.objects, which the Storage
-- API applies to every upload. The bucket MIME allowlist and size limit are
-- enforced by the Storage API service itself, not by Postgres, so this
-- script can only read them; test those with real uploads.
--
-- The last section creates a temporary policy that allows every UPDATE, to
-- test the restrictive rename guard on its own. Like everything else here it
-- is rolled back, but while the script runs (well under a second) it holds a
-- lock on storage.objects that makes other storage requests wait.
--
-- Success: the notice "ALL n CHECKS PASSED", then ROLLBACK.
-- Failure: an exception naming the failed check; the transaction aborts.

begin;

do $$
declare
  v_viewer   uuid := gen_random_uuid();
  v_editor   uuid := gen_random_uuid();
  v_tag      text := substr(md5(random()::text), 1, 8);
  v_campaign uuid;
  v_other    uuid := gen_random_uuid();
  v_sha      text := encode(sha256(convert_to(random()::text, 'UTF8')), 'hex');
  v_media    text := 'media/' || gen_random_uuid()::text || '/';
  v_bucket   storage.buckets;
  v_name     text;
  v_legacy   text;
  v_n        integer;
  v_passed   integer := 0;
begin
  -- ====================================================== bucket settings
  select * into v_bucket from storage.buckets where id = 'ar-media';
  if not v_bucket.public
     or v_bucket.file_size_limit is distinct from 52428800
     or (select array_agg(t order by t) from unnest(v_bucket.allowed_mime_types) t)
        is distinct from array['application/octet-stream', 'image/jpeg', 'image/png',
                               'image/webp', 'model/gltf-binary', 'video/mp4', 'video/webm'] then
    raise exception 'FAIL bucket: ar-media settings are not as intended';
  end if;
  if 'text/html' = any (v_bucket.allowed_mime_types)
     or 'image/svg+xml' = any (v_bucket.allowed_mime_types) then
    raise exception 'FAIL bucket: ar-media allows HTML or SVG';
  end if;
  v_passed := v_passed + 1;

  select * into v_bucket from storage.buckets where id = 'ar-sources';
  if v_bucket.public
     or v_bucket.file_size_limit is distinct from 20971520
     or (select array_agg(t order by t) from unnest(v_bucket.allowed_mime_types) t)
        is distinct from array['image/jpeg', 'image/png'] then
    raise exception 'FAIL bucket: ar-sources is no longer private, 20 MB, PNG/JPEG';
  end if;
  v_passed := v_passed + 1;
  raise notice 'PASS bucket settings';

  -- ============================================================ fixtures
  perform set_config('request.jwt.claims', '', true);

  insert into auth.users (id, email, aud, role)
  values (v_viewer, 'm1-viewer-' || v_tag || '@example.invalid', 'authenticated', 'authenticated'),
         (v_editor, 'm1-editor-' || v_tag || '@example.invalid', 'authenticated', 'authenticated');
  insert into public.user_roles (user_id, role)
  values (v_viewer, 'viewer'), (v_editor, 'editor');

  insert into public.campaigns (name, slug)
  values ('M1 ' || v_tag, 'm1-' || v_tag)
  returning id into v_campaign;

  -- A pack reserved by the editor, as cms_reserve_target_pack leaves it.
  insert into public.target_packs (campaign_id, version, storage_provider, bucket,
                                   storage_key, sha256, file_size, target_count,
                                   source_hash, compiler_version, status, created_by)
  values (v_campaign, 1, 'supabase', 'ar-media',
          format('targets/%s/v1/targets.mind', v_campaign), v_sha, 2048, 1,
          v_sha, '1.2.5', 'uploaded', v_editor);

  -- ============================================================== editor
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_editor, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  foreach v_name in array array['mp4', 'webm', 'glb', 'png', 'jpg', 'webp'] loop
    insert into storage.objects (bucket_id, name)
    values ('ar-media', v_media || v_sha || '.' || v_name);
  end loop;
  v_passed := v_passed + 1;
  raise notice 'PASS editor stores mp4, webm, glb, png, jpg and webp media';

  foreach v_name in array array[
    v_media || v_sha || '.html',
    v_media || v_sha || '.svg',
    v_media || v_sha || '.mkv',
    v_media || v_sha || '.mov',
    v_media || v_sha || '.MP4',
    v_media || v_sha || '.mp4.html',
    v_media || v_sha || '/x.mp4',
    v_media || 'x.mp4',
    'media/' || upper(gen_random_uuid()::text) || '/' || v_sha || '.mp4',
    'media/x.mp4',
    'index.html',
    'scanner/x/' || v_sha || '.png',
    format('targets/%s/v1/targets.html', v_campaign),
    format('targets/%s/v1/targets.mind', v_other)
  ] loop
    begin
      insert into storage.objects (bucket_id, name) values ('ar-media', v_name);
      raise exception 'FAIL editor: stored %', v_name;
    exception when insufficient_privilege then
      v_passed := v_passed + 1;
    end;
  end loop;
  raise notice 'PASS editor cannot store HTML, SVG, MKV, MOV or any off-pattern name';

  -- The reserved target pack upload still works.
  insert into storage.objects (bucket_id, name)
  values ('ar-media', format('targets/%s/v1/targets.mind', v_campaign));
  v_passed := v_passed + 1;
  raise notice 'PASS editor uploads the target pack they reserved';

  -- No rename or move inside ar-media: zero rows, or an error.
  begin
    update storage.objects set name = v_media || v_sha || '.html'
     where bucket_id = 'ar-media' and name = v_media || v_sha || '.mp4';
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL editor: renamed a media object'; end if;
  exception when insufficient_privilege then
    null;
  end;
  v_passed := v_passed + 1;

  -- Other buckets keep their own rules: the path guard is ar-media only.
  insert into storage.objects (bucket_id, name)
  values ('ar-sources', format('triggers/%s/%s/%s.png', v_campaign, gen_random_uuid(), v_sha));
  v_passed := v_passed + 1;
  raise notice 'PASS no rename in ar-media; ar-sources uploads unchanged';

  -- ============================================================== viewer
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_viewer, 'role', 'authenticated')::text, true);
  begin
    insert into storage.objects (bucket_id, name)
    values ('ar-media', 'media/' || gen_random_uuid()::text || '/' || v_sha || '.mp4');
    raise exception 'FAIL viewer: stored media';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;

  -- ================================================================ anon
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
  begin
    insert into storage.objects (bucket_id, name)
    values ('ar-media', 'media/' || gen_random_uuid()::text || '/' || v_sha || '.mp4');
    raise exception 'FAIL anon: stored media';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;
  raise notice 'PASS viewer and anon cannot store media';

  -- ============================================== rename guard, isolated
  perform set_config('role', 'none', true);

  -- No real permissive UPDATE policy can reach ar-media: one that names it,
  -- or one that does not restrict the bucket at all.
  select string_agg(policyname, ', ') into v_name
    from pg_catalog.pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and permissive = 'PERMISSIVE' and cmd in ('UPDATE', 'ALL')
     and ((coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%ar-media%'
          or (coalesce(qual, '') || ' ' || coalesce(with_check, '')) not like '%bucket_id%');
  if v_name is not null then
    raise exception 'FAIL policies: permissive UPDATE policies can reach ar-media: %', v_name;
  end if;
  v_passed := v_passed + 1;

  -- An object stored before the fix under a name the rule refuses. Written
  -- as postgres; skipped where postgres is subject to row level security.
  v_legacy := 'media/legacy-' || v_tag || '/clip.mov';
  begin
    insert into storage.objects (bucket_id, name) values ('ar-media', v_legacy);
  exception when insufficient_privilege then
    v_legacy := null;
  end;

  create policy m1_test_allow_every_update on storage.objects
    for update to authenticated using (true) with check (true);

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_editor, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- WITH CHECK: the new name must be valid.
  begin
    update storage.objects set name = v_media || v_sha || '.html'
     where bucket_id = 'ar-media' and name = v_media || v_sha || '.mp4';
    raise exception 'FAIL rename guard: renamed media to .html';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;

  -- A valid object with an unchanged name can still be updated.
  update storage.objects set metadata = '{"m1": "test"}'
   where bucket_id = 'ar-media' and name = v_media || v_sha || '.mp4';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL rename guard: blocked a valid update'; end if;
  v_passed := v_passed + 1;

  -- USING: an object whose current name is invalid cannot be updated, not
  -- even to give it a valid name.
  if v_legacy is not null then
    update storage.objects set name = 'media/' || gen_random_uuid()::text || '/' || v_sha || '.webm'
     where bucket_id = 'ar-media' and name = v_legacy;
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL rename guard: updated an off-pattern object'; end if;
    v_passed := v_passed + 1;
  else
    raise notice 'SKIPPED off-pattern update check: postgres cannot write storage.objects here';
  end if;

  -- The guard is ar-media only.
  update storage.objects set metadata = '{"m1": "test"}'
   where bucket_id = 'ar-sources' and name like format('triggers/%s/%%', v_campaign);
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL rename guard: blocked an ar-sources update'; end if;
  v_passed := v_passed + 1;

  -- Target pack files stay immutable (Phase 2B guard).
  update storage.objects set metadata = '{"m1": "test"}'
   where bucket_id = 'ar-media' and name = format('targets/%s/v1/targets.mind', v_campaign);
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL target pack: its stored file was updated'; end if;
  v_passed := v_passed + 1;
  raise notice 'PASS rename guard checks the current and the new name; pack files stay immutable';

  perform set_config('role', 'none', true);
  raise notice 'ALL % CHECKS PASSED', v_passed;
end;
$$;

rollback;
