-- Phase 2C.3 security fix H1: only an Admin may change the status of the
-- live campaign. STAGING FIRST. Apply after 20261016093000. One transaction.
--
-- PROBLEM
--   campaigns_update lets an Editor update every column of a campaign. The
--   guard trigger protected live_release_id only, and
--   cms_get_live_manifest() serves a release only while its campaign is
--   'active'. An Editor could therefore archive the live campaign with one
--   REST PATCH: the scanner lost its release and fell back to the legacy
--   content, without any Admin publish or rollback.
--
-- FIX
--   cms_guard_campaign() is replaced. It keeps the Phase 2C.2 rule verbatim
--   (only cms_publish_release moves the live pointer) and adds two rules:
--     1. The status of a campaign that has a live release can only be
--        changed by an Admin. As in Phase 2A, a session with no signed-in
--        user (SQL editor, service role) is a database operator and is not
--        blocked.
--     2. The live pointer can only be set on an active campaign. This closes
--        the race in which an Editor archives a campaign that is not live
--        yet while an Admin's publish of it is in flight.
--   The function stays SECURITY INVOKER: the Phase 2C.2 rule compares
--   current_user with the owner of cms_publish_release, which only works
--   while the trigger runs as the caller.
--
-- WHAT IT DOES NOT TOUCH
--   No policy, grant, table, constraint or row. Editors keep every other
--   campaign edit, and keep full control of the status of campaigns that are
--   not live. Publish, rollback and release immutability are unchanged.
--
-- ROLLBACK
--   Re-run the cms_guard_campaign() definition from 20261016090000.

begin;

-- ================================================================ preflight

do $$
begin
  if to_regprocedure('public.cms_publish_release(uuid)') is null
     or to_regprocedure('public.cms_get_live_manifest()') is null
     or to_regprocedure('public.cms_guard_campaign()') is null
     or to_regprocedure('public.cms_has_role(text)') is null then
    raise exception 'Phase 2C.2 must be installed before this fix. Nothing was changed.';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.campaigns'::regclass
       and t.tgname = 'cms_guard'
       and t.tgfoid = 'public.cms_guard_campaign()'::regprocedure
       and t.tgenabled <> 'D'
       and not t.tgisinternal
  ) then
    raise exception 'Trigger cms_guard on public.campaigns is missing or disabled. Review it first. Nothing was changed.';
  end if;

  -- Rows written before this fix are reported, never changed.
  if exists (
    select 1 from public.campaigns
     where live_release_id is not null and status <> 'active'
  ) then
    raise warning
      'A campaign with a live release is not active, so the scanner serves no CMS release. Review it with an Admin; this migration does not change it.';
  end if;
end;
$$;

-- ==================================================================== guard

create or replace function public.cms_guard_campaign()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Phase 2C.2: only cms_publish_release (running as its owner) moves the
  -- live pointer.
  if (tg_op = 'INSERT' and new.live_release_id is not null)
     or (tg_op = 'UPDATE' and new.live_release_id is distinct from old.live_release_id) then
    if current_user <> (
       select pg_catalog.pg_get_userbyid(proowner)
       from pg_catalog.pg_proc
       where oid = 'public.cms_publish_release(uuid)'::regprocedure
    ) then
      raise exception 'The live release can only change through cms_publish_release.'
        using errcode = '42501';
    end if;

    -- The scanner serves the live release only while its campaign is active.
    if new.live_release_id is not null and new.status is distinct from 'active' then
      raise exception 'Only an active campaign can have a live release.'
        using errcode = '23514';
    end if;
  end if;

  -- H1: the status of the live campaign decides what every visitor sees, so
  -- changing it is an Admin action like publish and rollback.
  if tg_op = 'UPDATE'
     and old.live_release_id is not null
     and new.status is distinct from old.status then
    if auth.uid() is not null then
      if not public.cms_has_role('admin') then
        raise exception 'Only an Admin can change the status of the live campaign.'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end
$$;

-- =============================================================== postflight

do $$
declare
  v_fn pg_catalog.pg_proc;
begin
  select * into v_fn from pg_catalog.pg_proc
   where oid = 'public.cms_guard_campaign()'::regprocedure;

  -- SECURITY DEFINER would make every caller look like the publish
  -- function's owner and silently open the live pointer.
  if v_fn.prosecdef then
    raise exception 'cms_guard_campaign() must stay SECURITY INVOKER. Rolled back.';
  end if;
  if v_fn.proconfig is null or not ('search_path=""' = any (v_fn.proconfig)) then
    raise exception 'cms_guard_campaign() lost its empty search_path. Rolled back.';
  end if;
  if position('Only an Admin can change the status of the live campaign.' in v_fn.prosrc) = 0 then
    raise exception 'cms_guard_campaign() does not contain the H1 rule. Rolled back.';
  end if;

  -- The fix relies on the Phase 2A policies being the only ones on campaigns.
  if exists (
    select 1 from pg_catalog.pg_policies
     where schemaname = 'public' and tablename = 'campaigns'
       and policyname not in ('campaigns_select', 'campaigns_insert',
                              'campaigns_update', 'campaigns_delete')
  ) then
    raise exception 'Unexpected policies on public.campaigns. Review them. Rolled back.';
  end if;
  if has_table_privilege('anon', 'public.campaigns', 'UPDATE')
     or has_table_privilege('anon', 'public.campaigns', 'INSERT') then
    raise exception 'anon can write public.campaigns. Rolled back.';
  end if;
end;
$$;

commit;
