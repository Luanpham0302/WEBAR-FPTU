-- EMERGENCY ONLY. Undoes migration 20261014090000_cms_target_packs.sql and
-- returns the database to the state after the four Phase 2A files.
--
-- It removes rules, not data: every target pack, item, artwork and stored
-- file stays. After it, the Target Packs screen cannot save (it reports that
-- the migration is not applied); the rest of the admin and the public
-- scanner are unaffected, exactly as before Phase 2B.
--
-- Deploying the previous frontend is NOT required for the scanner. Do it
-- only if you want the Target Packs screen gone as well.
--
-- One transaction.

begin;

-- Storage.
drop policy if exists cms_target_objects_insert on storage.objects;
drop policy if exists cms_pack_objects_insert_guard on storage.objects;
drop policy if exists cms_pack_objects_update_guard on storage.objects;
drop policy if exists cms_pack_objects_protect on storage.objects;

-- The release rule.
drop trigger if exists cms_guard_pack on public.releases;
drop function if exists public.cms_guard_release_pack();

-- Functions that are the Phase 2B write path.
drop function if exists public.cms_reserve_target_pack(
  uuid, text, text, text, bigint, text, text, jsonb);
drop function if exists public.cms_verify_target_pack(uuid);
drop function if exists public.cms_set_target_pack_status(uuid, text);
drop function if exists public.cms_is_reserved_pack_object(text, text);
drop function if exists public.cms_is_protected_pack_object(text, text);
drop function if exists public.cms_is_pack_object(text, text);
drop function if exists public.cms_pack_source_hash(text, jsonb);
drop function if exists public.cms_mindar_version();
drop function if exists public.cms_pack_max_bytes();

-- Triggers added by Phase 2B.
drop trigger if exists cms_guard on public.target_pack_items;
drop trigger if exists cms_guard_delete on public.target_pack_items;
drop trigger if exists cms_guard_delete on public.target_packs;
drop function if exists public.cms_guard_target_pack_item();
drop function if exists public.cms_guard_target_pack_delete();

-- The Phase 2A version of the pack guard: only the status may change.
create or replace function public.cms_guard_target_pack()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'A target pack is immutable. Only its status can change.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

grant execute on function public.cms_guard_target_pack() to public;

-- The three Phase 2A policies, exactly as Phase 2A created them.
drop policy if exists target_packs_insert on public.target_packs;
drop policy if exists target_packs_update on public.target_packs;
drop policy if exists target_pack_items_insert on public.target_pack_items;

create policy target_packs_insert on public.target_packs
  for insert to authenticated
  with check ((select public.cms_has_role('editor')));
create policy target_packs_update on public.target_packs
  for update to authenticated
  using ((select public.cms_has_role('editor')))
  with check ((select public.cms_has_role('editor')));
create policy target_pack_items_insert on public.target_pack_items
  for insert to authenticated
  with check ((select public.cms_has_role('editor')));

-- Documentation added by Phase 2B.
comment on column public.target_packs.sha256 is null;
comment on column public.target_packs.status is null;

-- Uniqueness rules.
alter table public.target_pack_items
  drop constraint if exists target_pack_items_trigger_unique;
drop index if exists public.artworks_campaign_trigger_unique_idx;

commit;
