-- Phase 2A, file 2 of 3: role helpers, triggers and row level security.
--
-- Requires file 1. Does not touch ar_content or its policies.

begin;

-- ============================================================ role helpers
-- SECURITY DEFINER so policies can read user_roles without recursing into
-- the policies of user_roles itself. Both only ever look at the caller.

create function public.cms_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ur.role
    from public.user_roles ur
   where ur.user_id = (select auth.uid());
$$;

-- viewer < editor < admin. No row, or an unknown level, is false.
create function public.cms_has_role(min_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case min_role
             when 'viewer' then ur.role in ('viewer', 'editor', 'admin')
             when 'editor' then ur.role in ('editor', 'admin')
             when 'admin'  then ur.role = 'admin'
             else false
           end
      from public.user_roles ur
     where ur.user_id = (select auth.uid())
  ), false);
$$;

revoke all on function public.cms_role() from public, anon;
revoke all on function public.cms_has_role(text) from public, anon;
grant execute on function public.cms_role() to authenticated;
grant execute on function public.cms_has_role(text) to authenticated;

-- ======================================================= stamping triggers
-- Clients cannot forge who or when: the server fills these columns.
-- auth.uid() is null in the SQL editor and for the service role.

create function public.cms_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := coalesce(auth.uid(), old.updated_by);
  end if;
  return new;
end;
$$;

create function public.cms_stamp_created()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  new.created_by := coalesce(auth.uid(), new.created_by);
  return new;
end;
$$;

create function public.cms_stamp_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  new.granted_by := coalesce(auth.uid(), new.granted_by);
  return new;
end;
$$;

create trigger cms_stamp before insert or update on public.campaigns
  for each row execute function public.cms_stamp();
create trigger cms_stamp before insert or update on public.media
  for each row execute function public.cms_stamp();
create trigger cms_stamp before insert or update on public.artworks
  for each row execute function public.cms_stamp();
create trigger cms_stamp before insert or update on public.artwork_layers
  for each row execute function public.cms_stamp();
create trigger cms_stamp before insert on public.target_packs
  for each row execute function public.cms_stamp_created();
create trigger cms_stamp before insert on public.releases
  for each row execute function public.cms_stamp_created();
create trigger cms_stamp before insert or update on public.user_roles
  for each row execute function public.cms_stamp_role();

-- ========================================================== guard triggers
-- RLS decides who may write a row. These decide which columns may change.

-- The live pointer is the publish action, so only an Admin may move it.
-- Phase 2C replaces direct writes with a publish function.
create function public.cms_guard_campaign()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.live_release_id is not null)
     or (tg_op = 'UPDATE' and new.live_release_id is distinct from old.live_release_id) then
    if auth.uid() is not null and not public.cms_has_role('admin') then
      raise exception 'Only an Admin can change the live release of a campaign.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger cms_guard before insert or update on public.campaigns
  for each row execute function public.cms_guard_campaign();

-- Media bytes are immutable. Name, status, video_mode and the measured
-- width/height/duration stay editable.
create function public.cms_guard_media()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.type is distinct from old.type
     or new.storage_provider is distinct from old.storage_provider
     or new.bucket is distinct from old.bucket
     or new.storage_key is distinct from old.storage_key
     or new.sha256 is distinct from old.sha256
     or new.mime_type is distinct from old.mime_type
     or new.file_size is distinct from old.file_size then
    raise exception 'A media file cannot be changed. Upload a new media object instead.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger cms_guard before update on public.media
  for each row execute function public.cms_guard_media();

-- An artwork stays in its campaign: its trigger path and any pack item that
-- references it are tied to that campaign.
create function public.cms_guard_artwork()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.campaign_id is distinct from old.campaign_id then
    raise exception 'An artwork cannot be moved to another campaign.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger cms_guard before update on public.artworks
  for each row execute function public.cms_guard_artwork();

-- A compiled pack is written once. Only its status may change.
create function public.cms_guard_target_pack()
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

create trigger cms_guard before update on public.target_packs
  for each row execute function public.cms_guard_target_pack();

-- A release is an immutable snapshot. Only the publish fields may change.
create function public.cms_guard_release()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.campaign_id is distinct from old.campaign_id
     or new.version is distinct from old.version
     or new.target_pack_id is distinct from old.target_pack_id
     or new.manifest is distinct from old.manifest
     or new.preview_token is distinct from old.preview_token
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'A release is immutable. Create a new release instead.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger cms_guard before update on public.releases
  for each row execute function public.cms_guard_release();

-- ============================================================= audit trail
-- Records every insert, update and delete on the CMS tables. Updates store
-- only the columns that changed. The manifest is left out: it is large and
-- already kept forever in releases.

create function public.cms_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old    jsonb;
  v_new    jsonb;
  v_row    jsonb;
  v_detail jsonb;
begin
  if tg_op <> 'INSERT' then
    v_old := to_jsonb(old) - 'manifest';
  end if;

  if tg_op <> 'DELETE' then
    v_new := to_jsonb(new) - 'manifest';
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(
             n.key, jsonb_build_object('old', o.value, 'new', n.value))
      into v_detail
      from jsonb_each(v_new) n
      join jsonb_each(v_old) o on o.key = n.key
     where n.value is distinct from o.value
       and n.key not in ('updated_at', 'updated_by');

    -- Nothing but the timestamp changed.
    if v_detail is null then
      return null;
    end if;
  elsif tg_op = 'INSERT' then
    v_detail := v_new;
  else
    v_detail := v_old;
  end if;

  v_row := coalesce(v_new, v_old);

  insert into public.audit_log (actor_id, action, entity, entity_id, detail)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'user_id'),
    v_detail
  );

  return null;
end;
$$;

revoke all on function public.cms_audit() from public, anon, authenticated;

create trigger cms_audit after insert or update or delete on public.campaigns
  for each row execute function public.cms_audit();
create trigger cms_audit after insert or update or delete on public.media
  for each row execute function public.cms_audit();
create trigger cms_audit after insert or update or delete on public.artworks
  for each row execute function public.cms_audit();
create trigger cms_audit after insert or update or delete on public.artwork_layers
  for each row execute function public.cms_audit();
create trigger cms_audit after insert or update or delete on public.target_packs
  for each row execute function public.cms_audit();
create trigger cms_audit after insert or update or delete on public.releases
  for each row execute function public.cms_audit();
create trigger cms_audit after insert or update or delete on public.user_roles
  for each row execute function public.cms_audit();

-- ====================================================== row level security
-- Anonymous visitors get nothing from these tables: no anon policy exists,
-- and the table grants are removed as a second barrier.

alter table public.campaigns         enable row level security;
alter table public.media             enable row level security;
alter table public.artworks          enable row level security;
alter table public.artwork_layers    enable row level security;
alter table public.target_packs      enable row level security;
alter table public.target_pack_items enable row level security;
alter table public.releases          enable row level security;
alter table public.user_roles        enable row level security;
alter table public.audit_log         enable row level security;

revoke all on
  public.campaigns, public.media, public.artworks, public.artwork_layers,
  public.target_packs, public.target_pack_items, public.releases,
  public.user_roles, public.audit_log
from anon;

-- ---- campaigns: Viewer reads, Editor writes, Admin hard-deletes.
create policy campaigns_select on public.campaigns
  for select to authenticated
  using ((select public.cms_has_role('viewer')));
create policy campaigns_insert on public.campaigns
  for insert to authenticated
  with check ((select public.cms_has_role('editor')));
create policy campaigns_update on public.campaigns
  for update to authenticated
  using ((select public.cms_has_role('editor')))
  with check ((select public.cms_has_role('editor')));
create policy campaigns_delete on public.campaigns
  for delete to authenticated
  using ((select public.cms_has_role('admin')));

-- ---- media: same shape. The guard trigger keeps file columns frozen.
create policy media_select on public.media
  for select to authenticated
  using ((select public.cms_has_role('viewer')));
create policy media_insert on public.media
  for insert to authenticated
  with check ((select public.cms_has_role('editor')));
create policy media_update on public.media
  for update to authenticated
  using ((select public.cms_has_role('editor')))
  with check ((select public.cms_has_role('editor')));
create policy media_delete on public.media
  for delete to authenticated
  using ((select public.cms_has_role('admin')));

-- ---- artworks: same shape.
create policy artworks_select on public.artworks
  for select to authenticated
  using ((select public.cms_has_role('viewer')));
create policy artworks_insert on public.artworks
  for insert to authenticated
  with check ((select public.cms_has_role('editor')));
create policy artworks_update on public.artworks
  for update to authenticated
  using ((select public.cms_has_role('editor')))
  with check ((select public.cms_has_role('editor')));
create policy artworks_delete on public.artworks
  for delete to authenticated
  using ((select public.cms_has_role('admin')));

-- ---- artwork_layers: pure working copy, so an Editor may also delete.
-- Releases keep their own snapshot and never read these rows at runtime.
create policy artwork_layers_select on public.artwork_layers
  for select to authenticated
  using ((select public.cms_has_role('viewer')));
create policy artwork_layers_insert on public.artwork_layers
  for insert to authenticated
  with check ((select public.cms_has_role('editor')));
create policy artwork_layers_update on public.artwork_layers
  for update to authenticated
  using ((select public.cms_has_role('editor')))
  with check ((select public.cms_has_role('editor')));
create policy artwork_layers_delete on public.artwork_layers
  for delete to authenticated
  using ((select public.cms_has_role('editor')));

-- ---- target_packs: an Editor compiles (insert) and sets the status.
create policy target_packs_select on public.target_packs
  for select to authenticated
  using ((select public.cms_has_role('viewer')));
create policy target_packs_insert on public.target_packs
  for insert to authenticated
  with check ((select public.cms_has_role('editor')));
create policy target_packs_update on public.target_packs
  for update to authenticated
  using ((select public.cms_has_role('editor')))
  with check ((select public.cms_has_role('editor')));
create policy target_packs_delete on public.target_packs
  for delete to authenticated
  using ((select public.cms_has_role('admin')));

-- ---- target_pack_items: insert-only. No update policy exists on purpose.
create policy target_pack_items_select on public.target_pack_items
  for select to authenticated
  using ((select public.cms_has_role('viewer')));
create policy target_pack_items_insert on public.target_pack_items
  for insert to authenticated
  with check ((select public.cms_has_role('editor')));
create policy target_pack_items_delete on public.target_pack_items
  for delete to authenticated
  using ((select public.cms_has_role('admin')));

-- ---- releases: an Editor may create a preview and nothing else. Changing a
-- release (publish, supersede) and deleting one are Admin only.
create policy releases_select on public.releases
  for select to authenticated
  using ((select public.cms_has_role('viewer')));
create policy releases_insert on public.releases
  for insert to authenticated
  with check (
    (select public.cms_has_role('editor'))
    and status = 'preview'
    and published_at is null
    and published_by is null
  );
create policy releases_update on public.releases
  for update to authenticated
  using ((select public.cms_has_role('admin')))
  with check ((select public.cms_has_role('admin')));
create policy releases_delete on public.releases
  for delete to authenticated
  using ((select public.cms_has_role('admin')));

-- ---- user_roles: everyone sees their own row; an Admin sees all. An Admin
-- manages other people only. Nobody can write their own row, so nobody can
-- make themselves Admin and an Admin cannot lock themselves out by mistake.
-- The first Admin is created by hand in the SQL editor.
create policy user_roles_select on public.user_roles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.cms_has_role('admin'))
  );
create policy user_roles_insert on public.user_roles
  for insert to authenticated
  with check (
    (select public.cms_has_role('admin'))
    and user_id <> (select auth.uid())
  );
create policy user_roles_update on public.user_roles
  for update to authenticated
  using (
    (select public.cms_has_role('admin'))
    and user_id <> (select auth.uid())
  )
  with check (
    (select public.cms_has_role('admin'))
    and user_id <> (select auth.uid())
  );
create policy user_roles_delete on public.user_roles
  for delete to authenticated
  using (
    (select public.cms_has_role('admin'))
    and user_id <> (select auth.uid())
  );

-- ---- audit_log: Admin reads. No write policy: only the audit trigger,
-- which runs as the table owner, can add rows, and nobody can edit them.
create policy audit_log_select on public.audit_log
  for select to authenticated
  using ((select public.cms_has_role('admin')));

commit;
