-- Run AFTER migration 20261014090000_cms_target_packs.sql.
-- Queries 1-4 are read-only. Query 5 tries forbidden writes as a signed-in
-- user; every attempt runs inside a block that is always rolled back, so it
-- leaves nothing behind whatever the outcome. Run each query on its own.

-- 1. Everything the migration created. Every column must be true.
select
  to_regprocedure('public.cms_reserve_target_pack(uuid,text,text,text,bigint,text,text,jsonb)') is not null as reserve_fn,
  to_regprocedure('public.cms_verify_target_pack(uuid)') is not null            as verify_fn,
  to_regprocedure('public.cms_set_target_pack_status(uuid,text)') is not null   as status_fn,
  public.cms_mindar_version() = '1.2.5'                                         as mindar_pinned,
  exists (select 1 from pg_indexes where schemaname = 'public'
            and indexname = 'artworks_campaign_trigger_unique_idx')             as artwork_trigger_unique,
  exists (select 1 from pg_constraint
           where conname = 'target_pack_items_trigger_unique')                  as pack_trigger_unique,
  (select count(*) from pg_trigger
    where not tgisinternal
      and tgrelid in ('public.target_packs'::regclass, 'public.target_pack_items'::regclass)
      and tgname in ('cms_guard', 'cms_guard_delete')) = 4                      as guard_triggers,
  not exists (select 1 from pg_policies where schemaname = 'public'
                and policyname in ('target_packs_insert', 'target_packs_update',
                                   'target_pack_items_insert'))                 as direct_write_policies_gone,
  exists (select 1 from pg_policies where schemaname = 'storage'
            and policyname = 'cms_target_objects_insert' and cmd = 'INSERT')    as upload_policy,
  (select count(*) from pg_policies where schemaname = 'storage'
      and permissive = 'RESTRICTIVE'
      and (policyname, cmd) in (('cms_pack_objects_insert_guard', 'INSERT'),
                                ('cms_pack_objects_update_guard', 'UPDATE'),
                                ('cms_pack_objects_protect', 'DELETE'))) = 3    as restrictive_storage_guards,
  not exists (select 1 from pg_policies where schemaname = 'public'
                and tablename in ('target_packs', 'target_pack_items')
                and cmd in ('INSERT', 'UPDATE', 'ALL'))                         as no_direct_write_policy_at_all,
  exists (select 1 from pg_trigger where not tgisinternal
            and tgrelid = 'public.releases'::regclass
            and tgname = 'cms_guard_pack'
            and (tgtype & 2) = 2      -- BEFORE
            and (tgtype & 4) = 4      -- INSERT
            and (tgtype & 16) = 16)   -- UPDATE
                                                                                as release_guard_on_insert_and_update,
  public.cms_pack_max_bytes() = 52428800                                        as pack_limit_is_50_mb,
  obj_description('public.cms_verify_target_pack(uuid)'::regprocedure)
    like '%Does NOT read the file%'                                             as content_boundary_documented;

-- 2. Policies now on the two pack tables. Expect only SELECT and DELETE:
--    target_packs_select, target_packs_delete,
--    target_pack_items_select, target_pack_items_delete.
select tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public'
   and tablename in ('target_packs', 'target_pack_items')
 order by 1, 3, 2;

-- 3. Who can call the new functions. anon and PUBLIC must not appear.
--    SECURITY DEFINER must be true for exactly these seven:
--    cms_reserve_target_pack, cms_verify_target_pack,
--    cms_set_target_pack_status, cms_is_reserved_pack_object,
--    cms_is_protected_pack_object, cms_is_pack_object, cms_guard_release_pack.
select p.proname as function,
       p.prosecdef as security_definer,
       coalesce(array_to_string(p.proconfig, ', '), '') as settings,
       (select string_agg(case when a.grantee = 0 then 'PUBLIC'
                               else pg_get_userbyid(a.grantee) end, ', '
                          order by 1)
          from aclexplode(p.proacl) a
         where a.privilege_type = 'EXECUTE') as can_execute
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('cms_reserve_target_pack', 'cms_verify_target_pack',
                     'cms_set_target_pack_status', 'cms_is_reserved_pack_object',
                     'cms_is_protected_pack_object', 'cms_is_pack_object',
                     'cms_guard_release_pack', 'cms_pack_source_hash',
                     'cms_pack_max_bytes',
                     'cms_mindar_version', 'cms_guard_target_pack',
                     'cms_guard_target_pack_item', 'cms_guard_target_pack_delete')
 order by 1;

-- 4. BASELINE AGAIN. Every value must equal query 8 of the pre-migration
--    file. (target_packs and target_pack_items too: the migration adds no
--    rows.)
select
  (select md5(coalesce(string_agg(id || ':' || config::text || ':' || updated_at::text,
                                  '|' order by id), ''))
     from public.ar_content)                                              as ar_content_md5,
  (select count(*) from public.releases)                                  as releases,
  (select md5(coalesce(string_agg(id::text || ':' || status || ':' || md5(manifest::text),
                                  '|' order by id), ''))
     from public.releases)                                                as releases_md5,
  (select md5(coalesce(string_agg(id::text || ':' || coalesce(live_release_id::text, '-'),
                                  '|' order by id), ''))
     from public.campaigns)                                               as live_pointers_md5,
  (select count(*) from public.target_packs)                              as target_packs,
  (select count(*) from public.target_pack_items)                         as target_pack_items,
  (select count(*) from public.artworks)                                  as artworks,
  (select count(*) from public.user_roles)                                as user_roles,
  (select count(*) from storage.objects)                                  as storage_objects,
  (select md5(coalesce(string_agg(policyname || ':' || cmd || ':' || coalesce(qual, '')
                                  || ':' || coalesce(with_check, ''),
                                  '|' order by policyname), ''))
     from pg_policies
    where schemaname = 'public' and tablename = 'ar_content')             as ar_content_policies_md5,
  (select md5(coalesce(string_agg(policyname || ':' || cmd || ':' || coalesce(qual, '')
                                  || ':' || coalesce(with_check, ''),
                                  '|' order by policyname), ''))
     from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname not in ('cms_target_objects_insert',
                             'cms_pack_objects_insert_guard',
                             'cms_pack_objects_update_guard',
                             'cms_pack_objects_protect'))                 as old_storage_policies_md5;

-- 5. ATTACK PROBES. Acts as a real signed-in user (the highest CMS role that
--    exists, Editor preferred) and tries what must be impossible. Each probe
--    is rolled back. Read the result table: every row must have pass = true.
--    Select and run this whole block, down to the final SELECT, together.
drop table if exists pg_temp.cms_probe_results;
create temp table cms_probe_results (
  n integer, probe text, expected text, outcome text, pass boolean
);

do $$
declare
  v_user     uuid;
  v_role     text;
  v_campaign uuid;
  v_pack     uuid;
  v_probe    record;
  v_rows     integer;
  v_outcome  text;
begin
  select ur.user_id, ur.role into v_user, v_role
    from public.user_roles ur
   where ur.role in ('editor', 'admin')
   order by (ur.role = 'editor') desc
   limit 1;

  select id into v_campaign from public.campaigns order by created_at limit 1;
  select id into v_pack from public.target_packs order by created_at limit 1;

  if v_user is null then
    insert into pg_temp.cms_probe_results
    values (0, 'setup', 'an Editor or Admin exists', 'no CMS user found', false);
    return;
  end if;

  for v_probe in
    select * from (values
      (1, 'direct INSERT into target_packs', 'blocked',
       format($q$insert into public.target_packs (campaign_id, version, bucket, storage_key, sha256, file_size, target_count, source_hash, compiler_version, status)
                 values (%L, 999999, 'ar-media', 'targets/probe/v999999/targets.mind', repeat('a', 64), 1, 1, 'probe', '1.2.5', 'verified')$q$,
              coalesce(v_campaign, gen_random_uuid()))),
      (2, 'direct UPDATE of a pack status', 'no rows',
       $q$update public.target_packs set status = 'verified'$q$),
      (3, 'direct INSERT into target_pack_items', 'blocked',
       format($q$insert into public.target_pack_items (pack_id, target_index, artwork_id, trigger_media_id, trigger_sha256, width, height)
                 values (%L, 0, gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1)$q$,
              coalesce(v_pack, gen_random_uuid()))),
      (4, 'direct DELETE of the items of usable packs', 'no rows or blocked',
       $q$delete from public.target_pack_items
           where pack_id in (select id from public.target_packs where status <> 'failed')$q$),
      (5, 'upload to an unreserved targets/ path', 'blocked',
       $q$insert into storage.objects (bucket_id, name) values ('ar-media', 'targets/probe/v1/targets.mind')$q$),
      (6, 'overwrite any ar-media object', 'no rows',
       $q$update storage.objects set name = name || '.probe' where bucket_id = 'ar-media'$q$),
      (7, 'reserve with a wrong compiler version', 'blocked',
       format($q$select public.cms_reserve_target_pack(%L, 'supabase', 'ar-media', repeat('a', 64), 1, 'x', '9.9.9', '[]'::jsonb)$q$,
              coalesce(v_campaign, gen_random_uuid()))),
      (8, 'reserve into another bucket', 'blocked',
       format($q$select public.cms_reserve_target_pack(%L, 'supabase', 'ar-assets', repeat('a', 64), 1, 'x', '1.2.5', '[]'::jsonb)$q$,
              coalesce(v_campaign, gen_random_uuid()))),
      (9, 'verify a pack that does not exist', 'blocked',
       $q$select public.cms_verify_target_pack(gen_random_uuid())$q$),
      (10, 'reserve with a malformed SHA-256', 'blocked',
       format($q$select public.cms_reserve_target_pack(%L, 'supabase', 'ar-media', 'NOT-A-HASH', 1, 'x', '1.2.5', '[]'::jsonb)$q$,
              coalesce(v_campaign, gen_random_uuid()))),
      (11, 'reserve with a zero file size', 'blocked',
       format($q$select public.cms_reserve_target_pack(%L, 'supabase', 'ar-media', repeat('a', 64), 0, 'x', '1.2.5', '[]'::jsonb)$q$,
              coalesce(v_campaign, gen_random_uuid()))),
      (12, 'move another object onto a targets/ path', 'no rows or blocked',
       $q$update storage.objects set name = 'targets/probe/v1/targets.mind' where bucket_id = 'ar-media'$q$),
      (13, 'delete the file of a usable pack', 'no rows',
       $q$delete from storage.objects o using public.target_packs p
           where o.bucket_id = p.bucket and o.name = p.storage_key and p.status <> 'failed'$q$),
      (14, 'reserve a pack larger than 50 MB', 'blocked',
       format($q$select public.cms_reserve_target_pack(%L, 'supabase', 'ar-media', repeat('a', 64), 52428801, 'x', '1.2.5', '[]'::jsonb)$q$,
              coalesce(v_campaign, gen_random_uuid()))),
      (15, 'publish a release with a direct UPDATE', 'no rows or blocked',
       $q$update public.releases set status = 'published', published_at = now() where status = 'preview'$q$),
      (16, 'repoint a release at another pack', 'no rows or blocked',
       $q$update public.releases set target_pack_id = gen_random_uuid()$q$),
      (17, 'insert a release that is already published', 'blocked',
       format($q$insert into public.releases (campaign_id, version, target_pack_id, manifest, status, published_at)
                 values (%L, 999999, %L, '{"schemaVersion":1}', 'published', now())$q$,
              coalesce(v_campaign, gen_random_uuid()), coalesce(v_pack, gen_random_uuid())))
    ) as t (n, probe, expected, statement)
  loop
    begin
      -- Become that user, exactly as the API would.
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', v_user::text, true);
      perform set_config('role', 'authenticated', true);

      execute v_probe.statement;
      get diagnostics v_rows = row_count;

      -- Reaching this line means the statement was accepted. Raise so the
      -- block, including the role switch and any write, is rolled back.
      raise exception using
        errcode = 'P0001',
        message = case when v_rows = 0 then 'PROBE:no rows' else 'PROBE:ALLOWED' end;
    exception when others then
      v_outcome := case
        when sqlerrm = 'PROBE:no rows' then 'no rows'
        when sqlerrm = 'PROBE:ALLOWED' then 'ALLOWED'
        else 'blocked: ' || sqlerrm
      end;
    end;

    insert into pg_temp.cms_probe_results
    values (
      v_probe.n,
      v_probe.probe || ' (as ' || v_role || ')',
      v_probe.expected,
      v_outcome,
      v_outcome <> 'ALLOWED'
        and (v_probe.expected <> 'blocked' or v_outcome like 'blocked:%')
    );
  end loop;
end;
$$;

select * from pg_temp.cms_probe_results order by n;
