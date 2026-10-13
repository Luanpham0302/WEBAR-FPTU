-- READ-ONLY. Run before migration 20261013120300_cms_hardening.sql.
-- Shows exactly what that migration will drop and keep. Changes nothing.

-- 1. ar_content policies and what happens to each.
select policyname,
       cmd,
       roles,
       case
         when policyname in ('Authenticated can insert AR config',
                             'Authenticated can update AR config')
           then 'DROP, replaced by an Admin-only policy'
         when cmd = 'SELECT' then 'KEEP'
         else 'UNEXPECTED: the migration will stop and change nothing'
       end as action
  from pg_policies
 where schemaname = 'public'
   and tablename = 'ar_content'
 order by policyname;

-- 2. Storage policies and what happens to each.
select policyname,
       cmd,
       roles,
       qual as using_expression,
       with_check,
       case
         when policyname like 'cms\_%' then 'KEEP (CMS policy)'
         when (coalesce(qual, '') || ' ' || coalesce(with_check, '')) not like '%ar-assets%'
           then case when cmd = 'SELECT' then 'KEEP'
                     else 'KEEP, but REVIEW: a write policy that names no ar-assets' end
         when cmd = 'SELECT' then 'KEEP (public read of ar-assets)'
         when cmd = 'ALL' then 'UNEXPECTED: the migration will stop and change nothing'
         else 'DROP'
       end as action
  from pg_policies
 where schemaname = 'storage'
   and tablename = 'objects'
 order by policyname;

-- 3. The migration needs at least one Admin, or nobody can publish.
select count(*) as admin_count
  from public.user_roles
 where role = 'admin';
