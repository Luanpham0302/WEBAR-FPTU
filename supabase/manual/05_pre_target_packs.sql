-- READ-ONLY. Run BEFORE migration 20261014090000_cms_target_packs.sql.
-- Changes nothing. Run each numbered query on its own and keep the results:
-- query 8 is compared with the same query after the migration.

-- 1. Prerequisites. Every row must say true, except already_applied = false.
select
  to_regprocedure('public.cms_has_role(text)') is not null          as phase_2a_roles,
  to_regclass('public.target_packs') is not null                    as phase_2a_tables,
  exists (select 1 from pg_policies where schemaname = 'public'
            and tablename = 'ar_content'
            and policyname = 'cms_ar_content_update')               as phase_2a_hardening,
  exists (select 1 from public.user_roles where role = 'admin')     as has_admin,
  to_regprocedure('public.cms_reserve_target_pack(uuid,text,text,text,bigint,text,text,jsonb)')
    is not null                                                     as already_applied;

-- 2. The three Phase 2A policies the migration drops. Expect exactly 3 rows.
select tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public'
   and policyname in ('target_packs_insert', 'target_packs_update',
                      'target_pack_items_insert')
 order by 1, 2;

-- 2b. Any OTHER write policy on the two pack tables. Expect 0 rows.
--     A row here is a policy the migration does not know about. It would
--     keep allowing direct writes, so the migration stops if one exists.
select tablename, policyname, cmd, permissive, roles,
       qual as using_expression, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('target_packs', 'target_pack_items')
   and cmd in ('INSERT', 'UPDATE', 'ALL')
   and policyname not in ('target_packs_insert', 'target_packs_update',
                          'target_pack_items_insert')
 order by 1, 2;

-- 2c. Triggers and timestamp columns on target_packs. Expect exactly:
--       cms_audit  AFTER  INSERT/UPDATE/DELETE
--       cms_guard  BEFORE UPDATE
--       cms_stamp  BEFORE INSERT
--     and has_updated_at = false. Nothing may rewrite the row before an
--     update, or a status-only change would be rejected as "immutable".
select t.tgname as trigger,
       case when (t.tgtype & 2) = 2 then 'BEFORE' else 'AFTER' end as timing,
       concat_ws('/',
         case when (t.tgtype & 4) = 4 then 'INSERT' end,
         case when (t.tgtype & 16) = 16 then 'UPDATE' end,
         case when (t.tgtype & 8) = 8 then 'DELETE' end) as events,
       p.proname as function,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'target_packs'
                  and column_name in ('updated_at', 'updated_by')) as has_updated_at
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'public.target_packs'::regclass
   and not t.tgisinternal
 order by 1;

-- 2d. How public.releases is protected today (Phase 2A). Expect:
--       constraint  a FOREIGN KEY (target_pack_id, campaign_id) to
--                   target_packs (id, campaign_id): a release cannot use a
--                   pack of another campaign
--       policy      releases_insert  INSERT  ... status = 'preview' ...
--       policy      releases_update  UPDATE  ... cms_has_role('admin') ...
--       policy      releases_delete  DELETE  ... cms_has_role('admin') ...
--       policy      releases_select  SELECT
--       trigger     cms_guard  BEFORE UPDATE  (target_pack_id, campaign_id
--                   and the manifest cannot change)
--     Any other INSERT, UPDATE or ALL policy would let someone publish or
--     alter a release outside those rules: review it before continuing.
select 'constraint' as kind, c.conname as name,
       pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
 where c.conrelid = 'public.releases'::regclass
   and c.contype in ('f', 'c', 'u')
union all
select 'policy', p.policyname,
       p.cmd || ' to ' || array_to_string(p.roles, ',')
         || coalesce(' using ' || p.qual, '')
         || coalesce(' with check ' || p.with_check, '')
  from pg_policies p
 where p.schemaname = 'public' and p.tablename = 'releases'
union all
select 'trigger', t.tgname,
       case when (t.tgtype & 2) = 2 then 'BEFORE ' else 'AFTER ' end
         || concat_ws('/',
              case when (t.tgtype & 4) = 4 then 'INSERT' end,
              case when (t.tgtype & 16) = 16 then 'UPDATE' end,
              case when (t.tgtype & 8) = 8 then 'DELETE' end)
  from pg_trigger t
 where t.tgrelid = 'public.releases'::regclass and not t.tgisinternal
 order by 1, 2;

-- 3. Artworks that share a trigger inside one campaign. Expect 0 rows.
--    Any row makes the migration stop without changing anything.
select a.campaign_id, c.name as campaign, a.trigger_sha256,
       count(*) as artworks, string_agg(a.name, ', ' order by a.name) as names
  from public.artworks a
  join public.campaigns c on c.id = a.campaign_id
 where a.trigger_sha256 is not null
   and a.status <> 'archived'
 group by a.campaign_id, c.name, a.trigger_sha256
having count(*) > 1;

-- 4. Packs that contain the same trigger twice. Expect 0 rows.
select pack_id, trigger_sha256, count(*) as times
  from public.target_pack_items
 group by pack_id, trigger_sha256
having count(*) > 1;

-- 5. Existing target packs and whether each is internally consistent.
--    Usually 0 rows: Phase 2A had no screen that creates packs. Existing
--    rows are kept as they are; the new rules apply to future changes.
select p.id, p.campaign_id, p.version, p.status, p.compiler_version,
       p.target_count,
       count(i.pack_id) as items,
       count(i.pack_id) = p.target_count as items_complete,
       coalesce(min(i.target_index) = 0
                and max(i.target_index) = p.target_count - 1, false) as indexes_ok,
       exists (select 1 from storage.objects o
                where o.bucket_id = p.bucket and o.name = p.storage_key) as file_in_storage
  from public.target_packs p
  left join public.target_pack_items i on i.pack_id = p.id
 group by p.id
 order by p.campaign_id, p.version;

-- 5b. Releases whose pack is not verified. Expect 0 rows. The migration
--     keeps such rows as they are, but from then on a release can only be
--     created for a verified pack, and Phase 2C assumes none exist.
select r.id as release_id, r.campaign_id, r.version, r.status as release_status,
       p.version as pack_version, p.status as pack_status
  from public.releases r
  join public.target_packs p on p.id = r.target_pack_id
 where p.status <> 'verified'
 order by r.campaign_id, r.version;

-- 6. Every write policy on storage.objects, with what it means for target
--    pack files. Expect no row marked STOP. Rows marked "contained" are
--    harmless after the migration: its restrictive policies override them.
select policyname, cmd, permissive, roles,
       qual as using_expression, with_check,
       case
         when 'anon' = any (roles) or 'public' = any (roles)
           then 'STOP: anonymous storage write. The migration will refuse to run.'
         when left(policyname, 4) = 'cms_' then 'ok (CMS policy)'
         when cmd in ('UPDATE', 'ALL')
           then 'contained: cannot change a pack file once the migration is applied'
         else 'contained: cannot write under ar-media/targets/ once the migration is applied'
       end as verdict
  from pg_policies
 where schemaname = 'storage'
   and tablename = 'objects'
   and cmd <> 'SELECT'
 order by policyname;

-- 6b. Does the storage of this project record a size for each object? The
--     verify function fails closed when it does not. Expect without_size = 0
--     (or no rows if nothing was uploaded yet).
select bucket_id,
       count(*) as objects,
       count(*) filter (where coalesce(metadata ->> 'size', '') !~ '^[0-9]+$') as without_size
  from storage.objects
 where bucket_id in ('ar-media', 'ar-sources', 'ar-assets')
 group by bucket_id
 order by bucket_id;

-- 6c. Upload size limits. The migration reserves packs of at most 50 MB
--     (public.cms_pack_max_bytes). Storage must accept at least that much:
--       * file_size_limit of ar-media: expect NULL (no bucket limit) or a
--         value of 52428800 or more;
--       * the project-wide limit is NOT visible to SQL. Check it in the
--         dashboard: Storage > Settings > "Upload file size limit". The
--         default is 50 MB, and 50 MB is the maximum on the Free plan.
--     If either is lower, larger packs fail at upload and are marked failed.
select id as bucket, public, file_size_limit,
       case
         when id <> 'ar-media' then ''
         when file_size_limit is null then 'ok: no bucket limit, the project limit applies'
         when file_size_limit >= 52428800 then 'ok'
         else 'LOWER than the 50 MB pack limit: packs above this size will fail to upload'
       end as verdict
  from storage.buckets
 where id in ('ar-media', 'ar-sources', 'ar-assets')
 order by id;

-- 7. Objects already under targets/ in ar-media. Expect 0 rows.
select name, created_at
  from storage.objects
 where bucket_id = 'ar-media'
   and name like 'targets/%'
 order by name;

-- 8. BASELINE. Save this row. The migration must not change any value.
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
