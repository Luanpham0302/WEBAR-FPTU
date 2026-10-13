-- READ-ONLY. Run in the Supabase SQL editor and send back the results.
-- It changes nothing. It shows how ar_content and the ar-assets bucket are
-- protected today, which the repository cannot tell us.

-- 1. Is row level security on for ar_content?
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname = 'ar_content';

-- 2. Policies on ar_content.
select policyname, cmd, roles, qual as using_expression, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename = 'ar_content'
 order by policyname;

-- 3. Table grants on ar_content.
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name = 'ar_content'
 order by grantee, privilege_type;

-- 4. Buckets.
select id, public, file_size_limit, allowed_mime_types
  from storage.buckets
 order by id;

-- 5. Every storage policy (they all live on storage.objects).
select policyname, cmd, roles, qual as using_expression, with_check
  from pg_policies
 where schemaname = 'storage'
   and tablename = 'objects'
 order by policyname;

-- 6. Who can sign in. Any of these can reach whatever "authenticated" allows.
select id, email, created_at, last_sign_in_at
  from auth.users
 order by created_at;
