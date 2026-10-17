-- Behaviour test for 20261017180000_cms_live_asset_protection.sql (M3).
--
-- Run as the postgres role AFTER the migration, in ONE session (psql, not
-- the SQL Editor). Every statement runs in ONE transaction that always ends
-- in ROLLBACK: the test users, campaign, pack, releases, media rows,
-- storage.objects rows and ar_content row it inserts are never committed, and
-- no file is uploaded or removed (these are metadata rows only). The live
-- release, its files and the published ar_content row are only read.
--
-- Roles are simulated the way PostgREST does it (transaction-local `role`
-- and `request.jwt.claims`), so row level security applies exactly as for a
-- Storage API call. Deletes set storage.allow_delete_query, as the Storage
-- API itself does, for Storage versions that refuse direct SQL deletes.
--
-- The last part creates a temporary policy that allows every UPDATE, to test
-- the restrictive update guards on their own. It is rolled back too, but
-- while the script runs (well under a second) it holds a lock on
-- storage.objects that makes other storage requests wait.
--
-- Success: the notice "ALL n CHECKS PASSED", then ROLLBACK.
-- Failure: an exception naming the failed check; the transaction aborts.

begin;

do $$
declare
  v_admin    uuid := gen_random_uuid();
  v_editor   uuid := gen_random_uuid();
  v_tag      text := substr(md5(random()::text), 1, 8);
  v_sha      text := encode(sha256(convert_to(random()::text, 'UTF8')), 'hex');
  v_campaign uuid;
  v_pack     uuid;
  v_media_a  uuid := gen_random_uuid();  -- named by a preview release
  v_media_b  uuid := gen_random_uuid();  -- named by a superseded release
  v_media_c  uuid := gen_random_uuid();  -- never released
  v_media_d  uuid := gen_random_uuid();  -- never released, kept for updates
  v_key_a    text;
  v_key_b    text;
  v_key_c    text;
  v_key_d    text;
  v_pack_key text;
  v_live     text;  -- scanner asset named by ar_content
  v_spare    text;  -- scanner asset nobody uses
  v_spare2   text;
  v_bucket   storage.buckets;
  v_name     text;
  v_n        integer;
  v_passed   integer := 0;
begin
  -- ====================================================== bucket settings
  select * into v_bucket from storage.buckets where id = 'ar-assets';
  if not v_bucket.public
     or v_bucket.file_size_limit is distinct from 52428800
     or (select array_agg(t order by t) from unnest(v_bucket.allowed_mime_types) t)
        is distinct from array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'] then
    raise exception 'FAIL bucket: ar-assets settings are not as intended';
  end if;
  if 'image/svg+xml' = any (v_bucket.allowed_mime_types) or 'text/html' = any (v_bucket.allowed_mime_types) then
    raise exception 'FAIL bucket: ar-assets allows SVG or HTML';
  end if;
  v_passed := v_passed + 1;

  select * into v_bucket from storage.buckets where id = 'ar-media';
  if v_bucket.file_size_limit is distinct from 52428800
     or (select array_agg(t order by t) from unnest(v_bucket.allowed_mime_types) t)
        is distinct from array['application/octet-stream', 'image/jpeg', 'image/png',
                               'image/webp', 'model/gltf-binary', 'video/mp4', 'video/webm'] then
    raise exception 'FAIL bucket: ar-media (M1) settings changed';
  end if;
  v_passed := v_passed + 1;
  raise notice 'PASS bucket settings';

  -- ============================================================ fixtures
  perform set_config('request.jwt.claims', '', true);

  insert into auth.users (id, email, aud, role)
  values (v_admin, 'm3-admin-' || v_tag || '@example.invalid', 'authenticated', 'authenticated'),
         (v_editor, 'm3-editor-' || v_tag || '@example.invalid', 'authenticated', 'authenticated');
  insert into public.user_roles (user_id, role) values (v_admin, 'admin'), (v_editor, 'editor');

  insert into public.campaigns (name, slug) values ('M3 ' || v_tag, 'm3-' || v_tag)
  returning id into v_campaign;

  v_pack_key := format('targets/%s/v1/targets.mind', v_campaign);
  insert into public.target_packs (campaign_id, version, storage_provider, bucket, storage_key,
                                   sha256, file_size, target_count, source_hash,
                                   compiler_version, status, created_by)
  values (v_campaign, 1, 'supabase', 'ar-media', v_pack_key, v_sha, 2048, 1, v_sha, '1.2.5',
          'verified', v_editor)
  returning id into v_pack;

  v_key_a := format('media/%s/%s.mp4', v_media_a, v_sha);
  v_key_b := format('media/%s/%s.webm', v_media_b, v_sha);
  v_key_c := format('media/%s/%s.png', v_media_c, v_sha);
  v_key_d := format('media/%s/%s.png', v_media_d, v_sha);

  insert into public.media (id, name, type, bucket, storage_key, sha256, mime_type, file_size,
                            width, height, video_mode)
  values (v_media_a, 'M3 a', 'VIDEO', 'ar-media', v_key_a, v_sha, 'video/mp4', 1024, 640, 480, 'normal'),
         (v_media_b, 'M3 b', 'VIDEO', 'ar-media', v_key_b, v_sha, 'video/webm', 1024, 640, 480, 'normal'),
         (v_media_c, 'M3 c', 'IMAGE', 'ar-media', v_key_c, v_sha, 'image/png', 1024, 64, 64, null),
         (v_media_d, 'M3 d', 'IMAGE', 'ar-media', v_key_d, v_sha, 'image/png', 1024, 64, 64, null);

  -- Two releases as cms_create_release builds them. Not 'published': the
  -- live release stays the only published one.
  insert into public.releases (campaign_id, version, target_pack_id, status, published_at, manifest)
  values
    (v_campaign, 1, v_pack, 'preview', null, jsonb_build_object(
       'schemaVersion', 1,
       'targetPack', jsonb_build_object('id', v_pack, 'asset',
         jsonb_build_object('provider', 'supabase', 'bucket', 'ar-media', 'key', v_pack_key)),
       'artworks', jsonb_build_array(jsonb_build_object('targetIndex', 0, 'layers', jsonb_build_array(
         jsonb_build_object('type', 'VIDEO', 'mediaId', v_media_a, 'asset',
           jsonb_build_object('provider', 'supabase', 'bucket', 'ar-media', 'key', v_key_a))))))),
    (v_campaign, 2, v_pack, 'superseded', now(), jsonb_build_object(
       'schemaVersion', 1,
       'targetPack', jsonb_build_object('id', v_pack, 'asset',
         jsonb_build_object('provider', 'supabase', 'bucket', 'ar-media', 'key', v_pack_key)),
       'artworks', jsonb_build_array(jsonb_build_object('targetIndex', 0, 'layers', jsonb_build_array(
         jsonb_build_object('type', 'VIDEO', 'mediaId', v_media_b, 'asset',
           jsonb_build_object('provider', 'supabase', 'bucket', 'ar-media', 'key', v_key_b)))))));

  v_live := format('scanner/scannerBorder/%s.png', v_sha);
  v_spare := format('scanner/scannerTitle/%s.png', v_sha);
  v_spare2 := format('scanner/scannerFrame/%s.png', v_sha);

  -- Metadata rows only, written as postgres (which bypasses row level security).
  begin
    insert into storage.objects (bucket_id, name)
    values ('ar-media', v_key_a), ('ar-media', v_key_b), ('ar-media', v_key_c),
           ('ar-media', v_key_d), ('ar-media', v_pack_key),
           ('ar-assets', v_live), ('ar-assets', v_spare), ('ar-assets', v_spare2);
  exception when insufficient_privilege then
    raise exception 'SETUP: postgres cannot write storage.objects here; run as a role that bypasses RLS';
  end;

  -- A separate ar_content row; the published 'main' row is not touched.
  insert into public.ar_content (id, config, updated_at)
  values ('m3-test-' || v_tag,
          jsonb_build_object('scannerBorder',
            'https://example.supabase.co/storage/v1/object/public/ar-assets/' || v_live),
          now());

  -- =============================================== Admin: deletes refused
  perform set_config('storage.allow_delete_query', 'true', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  foreach v_name in array array[v_key_a, v_key_b, v_pack_key] loop
    delete from storage.objects where bucket_id = 'ar-media' and name = v_name;
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL released: Admin deleted %', v_name; end if;
    v_passed := v_passed + 1;
  end loop;
  raise notice 'PASS Admin cannot delete files of a preview or superseded release, nor its pack file';

  delete from storage.objects where bucket_id = 'ar-media' and name = v_key_c;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL released: Admin could not delete an unreleased file'; end if;
  v_passed := v_passed + 1;
  raise notice 'PASS Admin still deletes a file no release names';

  delete from storage.objects where bucket_id = 'ar-assets' and name = v_live;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL scanner: Admin deleted an asset ar_content uses'; end if;
  v_passed := v_passed + 1;

  delete from storage.objects where bucket_id = 'ar-assets' and name = v_spare;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL scanner: Admin could not delete an unused scanner asset'; end if;
  v_passed := v_passed + 1;
  raise notice 'PASS scanner assets in use are kept; unused ones can be removed';

  -- ============================================ Admin: media rows of releases
  begin
    delete from public.media where id = v_media_a;
    raise exception 'FAIL media: Admin deleted a media row a release names';
  exception when check_violation then
    v_passed := v_passed + 1;
  end;
  begin
    delete from public.media where id = v_media_b;
    raise exception 'FAIL media: Admin deleted a media row a superseded release names';
  exception when check_violation then
    v_passed := v_passed + 1;
  end;

  delete from public.media where id = v_media_c;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL media: Admin could not delete an unreleased media row'; end if;
  v_passed := v_passed + 1;
  raise notice 'PASS media rows named by a release cannot be deleted; others can';

  -- ====================================================== Editor: ar-assets
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_editor, 'role', 'authenticated')::text, true);

  foreach v_name in array array['png', 'jpg', 'webp', 'mp4', 'webm'] loop
    insert into storage.objects (bucket_id, name)
    values ('ar-assets', format('scanner/loadingAnimation/%s.%s', md5(v_name || v_tag) || md5(v_tag), v_name));
  end loop;
  v_passed := v_passed + 1;
  raise notice 'PASS editor stores png, jpg, webp, mp4 and webm scanner assets';

  foreach v_name in array array[
    format('scanner/scannerBorder/%s.svg', md5(v_tag) || md5('x')),
    format('scanner/scannerBorder/%s.html', md5(v_tag) || md5('x')),
    format('scanner/scannerBorder/%s.gif', md5(v_tag) || md5('x')),
    format('scanner/scannerBorder/%s.mov', md5(v_tag) || md5('x')),
    format('scanner/scannerBorder/%s.PNG', md5(v_tag) || md5('x')),
    format('scanner/scannerBorder/%s.png.html', md5(v_tag) || md5('x')),
    format('scanner/scannerBorder/x/%s.png', md5(v_tag) || md5('x')),
    format('scanner/scanner-border/%s.png', md5(v_tag) || md5('x')),
    format('scanner/scannerBorder/%s.png', 'short'),
    'scanner/index.html',
    format('live/%s.png', md5(v_tag) || md5('x'))
  ] loop
    begin
      insert into storage.objects (bucket_id, name) values ('ar-assets', v_name);
      raise exception 'FAIL editor: stored ar-assets/%', v_name;
    exception when insufficient_privilege then
      v_passed := v_passed + 1;
    end;
  end loop;
  raise notice 'PASS editor cannot store SVG, HTML, GIF, MOV or any off-pattern name in ar-assets';

  delete from storage.objects where bucket_id = 'ar-media' and name = v_key_d;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL editor: deleted an ar-media object'; end if;
  v_passed := v_passed + 1;

  -- ======================================= update guards, tested on their own
  perform set_config('role', 'none', true);
  create policy m3_test_allow_every_update on storage.objects
    for update to authenticated using (true) with check (true);

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  update storage.objects set name = format('media/%s/%s.mp4', gen_random_uuid(), v_sha)
   where bucket_id = 'ar-media' and name = v_key_a;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL update guard: moved a released file'; end if;
  v_passed := v_passed + 1;

  update storage.objects set metadata = '{"m3": "test"}'
   where bucket_id = 'ar-media' and name = v_key_b;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL update guard: changed a released file'; end if;
  v_passed := v_passed + 1;

  update storage.objects set metadata = '{"m3": "test"}'
   where bucket_id = 'ar-media' and name = v_key_d;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL update guard: blocked an unreleased file'; end if;
  v_passed := v_passed + 1;

  begin
    update storage.objects set name = format('scanner/scannerFrame/%s.svg', v_sha)
     where bucket_id = 'ar-assets' and name = v_spare2;
    raise exception 'FAIL ar-assets rename guard: renamed a scanner asset to .svg';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;
  raise notice 'PASS released files cannot be moved or changed; ar-assets names stay valid';

  perform set_config('role', 'none', true);

  -- The live release, read only: every file it names is protected.
  select count(*) into v_n
    from public.campaigns c
    join public.releases r on r.id = c.live_release_id,
         jsonb_array_elements(r.manifest -> 'artworks') a,
         jsonb_array_elements(a -> 'layers') l
   where r.status = 'published'
     and not public.cms_is_released_object(l #>> '{asset,bucket}', l #>> '{asset,key}');
  if v_n <> 0 then raise exception 'FAIL live: % file(s) of the live release are unprotected', v_n; end if;
  v_passed := v_passed + 1;
  raise notice 'PASS every file of the live release is protected';

  raise notice 'ALL % CHECKS PASSED', v_passed;
end;
$$;

rollback;
