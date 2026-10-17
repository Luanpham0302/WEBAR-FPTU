-- Behaviour test for 20261017090000_cms_guard_live_campaign.sql (H1).
--
-- Run as the postgres role (Supabase SQL editor) AFTER the migration. Every
-- statement runs in ONE transaction that always ends in ROLLBACK: the test
-- users, campaigns, pack and releases it creates, and the publish and
-- rollback it performs, are never committed. Visitors keep seeing the
-- committed live release while it runs (MVCC).
--
-- Each role is simulated the way PostgREST does it: the transaction-local
-- settings `role` and `request.jwt.claims`. Row level security, triggers and
-- RPC grants therefore apply exactly as for a REST API call.
--
-- Success: the notice "ALL n CHECKS PASSED", then ROLLBACK.
-- Failure: an exception naming the failed check; the transaction aborts.

begin;

do $$
declare
  v_viewer uuid := gen_random_uuid();
  v_editor uuid := gen_random_uuid();
  v_admin  uuid := gen_random_uuid();
  v_tag    text := substr(md5(random()::text), 1, 8);
  v_sha    text := encode(sha256(convert_to(random()::text, 'UTF8')), 'hex');
  v_live   uuid;  -- campaign that gets published
  v_other  uuid;  -- campaign that never has a live release
  v_media  uuid;
  v_art    uuid;
  v_pack   uuid;
  v_r1     uuid;
  v_r2     uuid;
  v_first_published_at timestamptz;
  v_owner  text;
  v_n      integer;
  v_text   text;
  v_passed integer := 0;
begin
  -- ============================================================ fixtures
  -- Written as postgres (table owner): row level security does not apply.
  perform set_config('request.jwt.claims', '', true);

  insert into auth.users (id, email, aud, role)
  values (v_viewer, 'h1-viewer-' || v_tag || '@example.invalid', 'authenticated', 'authenticated'),
         (v_editor, 'h1-editor-' || v_tag || '@example.invalid', 'authenticated', 'authenticated'),
         (v_admin,  'h1-admin-'  || v_tag || '@example.invalid', 'authenticated', 'authenticated');

  insert into public.user_roles (user_id, role)
  values (v_viewer, 'viewer'), (v_editor, 'editor'), (v_admin, 'admin');

  insert into public.campaigns (name, slug)
  values ('H1 live ' || v_tag, 'h1-live-' || v_tag)
  returning id into v_live;
  insert into public.campaigns (name, slug)
  values ('H1 other ' || v_tag, 'h1-other-' || v_tag)
  returning id into v_other;

  insert into public.media (name, type, bucket, storage_key, sha256, mime_type,
                            file_size, width, height)
  values ('H1 trigger ' || v_tag, 'TRIGGER', 'ar-sources',
          'triggers/h1-test/' || v_tag || '/' || v_sha || '.png', v_sha,
          'image/png', 1024, 100, 100)
  returning id into v_media;

  insert into public.artworks (campaign_id, name, status, trigger_media_id,
                               trigger_width, trigger_height, trigger_sha256)
  values (v_live, 'H1 artwork', 'ready', v_media, 100, 100, v_sha)
  returning id into v_art;

  insert into public.target_packs (campaign_id, version, storage_provider, bucket,
                                   storage_key, sha256, file_size, target_count,
                                   source_hash, compiler_version, status)
  values (v_live, 1, 'supabase', 'ar-media',
          format('targets/%s/v1/targets.mind', v_live), v_sha, 2048, 1,
          v_sha, '1.2.5', 'uploaded')
  returning id into v_pack;

  insert into public.target_pack_items (pack_id, target_index, artwork_id,
                                        trigger_media_id, trigger_sha256, width, height)
  values (v_pack, 0, v_art, v_media, v_sha, 100, 100);

  update public.target_packs set status = 'verified' where id = v_pack;

  -- What the cms-verify-pack Edge Function records with the service role.
  insert into public.cms_trusted_pack_checks (pack_id, sha256, verifier_version)
  values (v_pack, v_sha, 'mind-ar@1.2.5');

  -- ============================================================== viewer
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_viewer, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  update public.campaigns set name = 'viewer edit' where id = v_other;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL viewer: renamed a campaign'; end if;
  v_passed := v_passed + 1;

  update public.campaigns set status = 'archived' where id = v_other;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL viewer: archived a campaign'; end if;
  v_passed := v_passed + 1;

  begin
    insert into public.campaigns (name, slug) values ('viewer', 'h1-viewer-' || v_tag);
    raise exception 'FAIL viewer: created a campaign';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;

  begin
    perform public.cms_create_release(v_pack, 'viewer');
    raise exception 'FAIL viewer: created a release';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;
  raise notice 'PASS viewer cannot change campaigns or create releases';

  -- ====================================================== editor, pre-live
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_editor, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_r1 := (public.cms_create_release(v_pack, 'H1 r1')).id;
  v_r2 := (public.cms_create_release(v_pack, 'H1 r2')).id;
  if v_r1 is null or v_r2 is null then
    raise exception 'FAIL editor: could not create releases';
  end if;
  v_passed := v_passed + 1;

  begin
    perform public.cms_publish_release(v_r1);
    raise exception 'FAIL editor: published a release';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;

  begin
    update public.campaigns set live_release_id = v_r1 where id = v_live;
    raise exception 'FAIL editor: moved the live pointer through the API';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;

  -- No UPDATE policy: zero rows, or an error where the table grant is absent.
  begin
    update public.releases set status = 'published' where id = v_r1;
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL editor: updated a release row directly'; end if;
  exception when insufficient_privilege then
    null;
  end;
  v_passed := v_passed + 1;
  raise notice 'PASS editor creates releases but cannot publish or move the pointer';

  -- ================================================================ publish
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  perform public.cms_publish_release(v_r1);

  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  if (select live_release_id from public.campaigns where id = v_live) is distinct from v_r1
     or (select status from public.releases where id = v_r1) <> 'published' then
    raise exception 'FAIL admin: publish did not make r1 live';
  end if;
  select published_at into v_first_published_at from public.releases where id = v_r1;
  v_passed := v_passed + 1;

  -- The anonymous scanner reads the live manifest.
  perform set_config('role', 'anon', true);
  if (public.cms_get_live_manifest() ->> 'releaseId')::uuid is distinct from v_r1 then
    raise exception 'FAIL anon: live manifest is not r1';
  end if;
  v_passed := v_passed + 1;
  raise notice 'PASS admin publishes; anon scanner reads the live release';

  -- ======================================================== H1: editor
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_editor, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  begin
    update public.campaigns set status = 'archived' where id = v_live;
    raise exception 'FAIL H1: an Editor archived the live campaign';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;

  -- Allowed: content edits of the live campaign, also when the PATCH body
  -- repeats the unchanged status, as a full-form save does.
  update public.campaigns
     set name = 'H1 live renamed ' || v_tag, description = 'edited by editor'
   where id = v_live;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL editor: could not edit the live campaign'; end if;
  v_passed := v_passed + 1;

  update public.campaigns set status = 'active', description = 'saved again'
   where id = v_live;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL editor: unchanged status blocked a save'; end if;
  v_passed := v_passed + 1;

  -- Allowed: status of a campaign that is not live.
  update public.campaigns set status = 'archived' where id = v_other;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL editor: could not archive a non-live campaign'; end if;
  update public.campaigns set status = 'active' where id = v_other;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL editor: could not reactivate a non-live campaign'; end if;
  v_passed := v_passed + 1;

  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  if (select status from public.campaigns where id = v_live) <> 'active'
     or (select live_release_id from public.campaigns where id = v_live) is distinct from v_r1 then
    raise exception 'FAIL H1: the live campaign changed';
  end if;
  v_passed := v_passed + 1;
  raise notice 'PASS H1: editor cannot change the live campaign status, other edits still work';

  -- ====================================================== publish/rollback
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  perform public.cms_publish_release(v_r2);
  perform public.cms_publish_release(v_r1);   -- rollback to the superseded r1

  begin
    update public.campaigns set live_release_id = v_r2 where id = v_live;
    raise exception 'FAIL admin: moved the live pointer through the API';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;

  begin
    update public.releases set notes = 'admin edit' where id = v_r1;
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL admin: updated a release row directly'; end if;
  exception when insufficient_privilege then
    null;
  end;
  v_passed := v_passed + 1;

  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  if (select live_release_id from public.campaigns where id = v_live) is distinct from v_r1
     or (select status from public.releases where id = v_r1) <> 'published'
     or (select status from public.releases where id = v_r2) <> 'superseded'
     or (select published_at from public.releases where id = v_r1) is distinct from v_first_published_at then
    raise exception 'FAIL: publish r2 then rollback to r1 did not end with r1 live';
  end if;
  v_passed := v_passed + 1;

  -- Release immutability holds even for the database owner.
  begin
    update public.releases set manifest = manifest || '{"x":1}' where id = v_r1;
    raise exception 'FAIL: a release manifest changed';
  exception when check_violation then
    v_passed := v_passed + 1;
  end;
  raise notice 'PASS publish, rollback and release immutability unchanged';

  -- ============================================================ H1: admin
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  update public.campaigns set status = 'archived' where id = v_live;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL admin: could not archive the live campaign'; end if;
  v_passed := v_passed + 1;

  begin
    perform public.cms_publish_release(v_r2);
    raise exception 'FAIL admin: published a release of an archived campaign';
  exception when check_violation then
    v_passed := v_passed + 1;
  end;

  -- An Editor cannot bring an archived live campaign back either.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_editor, 'role', 'authenticated')::text, true);
  begin
    update public.campaigns set status = 'active' where id = v_live;
    raise exception 'FAIL H1: an Editor reactivated the live campaign';
  exception when insufficient_privilege then
    v_passed := v_passed + 1;
  end;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.campaigns set status = 'active' where id = v_live;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL admin: could not reactivate the live campaign'; end if;
  v_passed := v_passed + 1;

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  if (public.cms_get_live_manifest() ->> 'releaseId')::uuid is distinct from v_r1 then
    raise exception 'FAIL anon: r1 is not live again after reactivation';
  end if;
  v_passed := v_passed + 1;
  raise notice 'PASS admin can archive and reactivate the live campaign';

  -- ============================================ live pointer on archived
  -- The second new rule, checked as the publish function's owner (the only
  -- role that passes the pointer rule). Skipped when the session runs as a
  -- different role.
  perform set_config('role', 'none', true);
  select pg_catalog.pg_get_userbyid(proowner) into v_owner
    from pg_catalog.pg_proc where oid = 'public.cms_publish_release(uuid)'::regprocedure;
  if current_user = v_owner then
    update public.campaigns set live_release_id = null where id = v_live;
    update public.campaigns set status = 'archived' where id = v_live;
    begin
      update public.campaigns set live_release_id = v_r1 where id = v_live;
      raise exception 'FAIL: the live pointer was set on an archived campaign';
    exception when check_violation then
      get stacked diagnostics v_text = message_text;
      if v_text <> 'Only an active campaign can have a live release.' then
        raise exception 'FAIL: unexpected error %', v_text;
      end if;
      v_passed := v_passed + 1;
    end;
    raise notice 'PASS the live pointer cannot land on an archived campaign';
  else
    raise notice 'SKIPPED pointer-on-archived check: session role % is not owner %',
      current_user, v_owner;
  end if;

  raise notice 'ALL % CHECKS PASSED', v_passed;
end;
$$;

rollback;
