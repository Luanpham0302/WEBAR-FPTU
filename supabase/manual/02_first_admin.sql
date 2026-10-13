-- Run once in the Supabase SQL editor, AFTER migration files 1-3 and BEFORE
-- file 4 (cms_hardening), which refuses to run until an Admin exists.
-- Replace the email with the account that should be the first Admin.
-- The SQL editor bypasses row level security, which is the only way to
-- create the first Admin: nobody can grant a role to themselves in the app.

insert into public.user_roles (user_id, role)
select id, 'admin'
  from auth.users
 where email = 'REPLACE_WITH_ADMIN_EMAIL'
on conflict (user_id) do update set role = excluded.role;

-- Check the result.
select u.email, r.role, r.created_at
  from public.user_roles r
  join auth.users u on u.id = r.user_id
 order by u.email;
