-- Phase 2C.1: content layer validation.
--
-- Requires the four Phase 2A files and the Phase 2B file. Run once, in the
-- Supabase SQL editor. One transaction: if any check fails, nothing changes.
--
-- WHAT IT DOES
--   Adds rules to public.artwork_layers, the table that attaches media to an
--   artwork (Phase 2A created it; nothing wrote to it until Phase 2C.1):
--     * a VIDEO layer must use an active VIDEO media item that has a video
--       mode and must have a fit; a MODEL_3D layer must use an active
--       MODEL_3D media item and must not have a fit;
--     * scale, position and rotation must be real numbers within range
--       (no NULL, no NaN, no Infinity); the order must be 0 or more;
--     * a layer stays on the artwork it was created for.
--   A trigger gives editors a readable message. Four CHECK constraints are
--   the backstop that holds even if the trigger were disabled.
--
-- NULL HANDLING
--   Phase 2A declares every one of these columns NOT NULL, and media.type
--   and media.status too. This file does not rely on that alone:
--     * the preflight stops if any of those NOT NULL constraints is missing;
--     * every CHECK below says "x is not null and ..." explicitly, because a
--       CHECK that evaluates to NULL counts as satisfied;
--     * every test in the trigger is written "(condition) is not true", so a
--       NULL fails it instead of slipping through.
--
-- WHAT IT DOES NOT TOUCH
--   No row is written or changed. No policy, bucket, release, live pointer,
--   target pack, ar_content or stored file is touched. Who may write layers
--   is unchanged (Phase 2A: Editor and Admin write, Viewer reads). No
--   earlier constraint, trigger or function is altered.
--
-- OBJECTS ADDED (and removed by supabase/manual/10_rollback_content_layers.sql)
--   function   public.cms_guard_artwork_layer()
--   trigger    cms_guard on public.artwork_layers
--   constraint artwork_layers_scale_range
--   constraint artwork_layers_position_range
--   constraint artwork_layers_rotation_range
--   constraint artwork_layers_sort_order_range
--
-- RANGES (units of the runtime: 1 = the width of the trigger image)
--   scale      0.05 .. 10
--   position   -5 .. 5     on x, y and z
--   rotation   -360 .. 360 degrees on x, y and z
--   sort_order 0 or more
-- Keep in step with LAYER_LIMITS in src/cms/layerRules.ts.

begin;

-- ================================================================ preflight

do $$
declare
  v_problem text;
begin
  if to_regprocedure('public.cms_guard_artwork_layer()') is not null
     or exists (select 1 from pg_constraint
                 where conrelid = 'public.artwork_layers'::regclass
                   and conname in ('artwork_layers_scale_range', 'artwork_layers_position_range',
                                   'artwork_layers_rotation_range', 'artwork_layers_sort_order_range')) then
    raise exception
      'This migration has already been applied, or part of it exists. Nothing was changed.';
  end if;

  if to_regprocedure('public.cms_reserve_target_pack(uuid,text,text,text,bigint,text,text,jsonb)') is null
     or to_regclass('public.artwork_layers') is null
     or to_regclass('public.media') is null then
    raise exception
      'Phase 2A and Phase 2B must be applied first. Nothing was changed.';
  end if;

  -- The schema this file builds on. Every required column must still be
  -- NOT NULL, as Phase 2A created it. A missing one means the schema has
  -- drifted; stop and review rather than guess.
  select string_agg(format('%s.%s', r.tbl, r.col), ', ' order by r.tbl, r.col)
    into v_problem
    from (values
            ('artwork_layers', 'artwork_id'), ('artwork_layers', 'media_id'),
            ('artwork_layers', 'layer_type'), ('artwork_layers', 'scale'),
            ('artwork_layers', 'position_x'), ('artwork_layers', 'position_y'),
            ('artwork_layers', 'position_z'), ('artwork_layers', 'rotation_x'),
            ('artwork_layers', 'rotation_y'), ('artwork_layers', 'rotation_z'),
            ('artwork_layers', 'loop'), ('artwork_layers', 'muted'),
            ('artwork_layers', 'enabled'), ('artwork_layers', 'sort_order'),
            ('media', 'type'), ('media', 'status')
         ) as r (tbl, col)
    left join information_schema.columns c
      on c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col
   where c.column_name is null or c.is_nullable <> 'NO';

  if v_problem is not null then
    raise exception
      'These columns are missing or no longer NOT NULL: %. The schema differs from Phase 2A; review it first. Nothing was changed.',
      v_problem;
  end if;

  -- Existing rows must already satisfy the new rules, or the constraints
  -- below would fail half-way. List every offender instead. Each test is
  -- "is not true", so a NULL counts as an offence.
  select string_agg(format('layer %s (%s)', l.id, reason), '; ')
    into v_problem
    from (
      select l.id,
             case
               when (l.scale >= 0.05 and l.scale <= 10) is not true then 'scale out of range'
               when (l.position_x between -5 and 5 and l.position_y between -5 and 5
                     and l.position_z between -5 and 5) is not true then 'position out of range'
               when (l.rotation_x between -360 and 360 and l.rotation_y between -360 and 360
                     and l.rotation_z between -360 and 360) is not true then 'rotation out of range'
               when (l.sort_order >= 0) is not true then 'negative or missing sort order'
               when m.id is null then 'media missing'
               when l.layer_type = 'VIDEO'
                    and (m.type is distinct from 'VIDEO' or m.video_mode is null)
                 then 'video layer on non-video media'
               when l.layer_type = 'MODEL_3D' and m.type is distinct from 'MODEL_3D'
                 then '3D layer on non-model media'
               when l.layer_type is distinct from 'VIDEO' and l.layer_type is distinct from 'MODEL_3D'
                 then 'unknown layer type'
             end as reason
        from public.artwork_layers l
        left join public.media m on m.id = l.media_id
    ) l
   where reason is not null;

  if v_problem is not null then
    raise exception
      'Existing content layers break the new rules: %. Fix them first. Nothing was changed.',
      v_problem;
  end if;
end;
$$;

-- ============================================================== backstop
-- Plain CHECK constraints, written to be false (not NULL) for a missing
-- value. NaN and Infinity fail every one of them too.

alter table public.artwork_layers
  add constraint artwork_layers_scale_range
    check (scale is not null and scale >= 0.05 and scale <= 10),
  add constraint artwork_layers_position_range
    check (position_x is not null and position_y is not null and position_z is not null
           and position_x between -5 and 5
           and position_y between -5 and 5
           and position_z between -5 and 5),
  add constraint artwork_layers_rotation_range
    check (rotation_x is not null and rotation_y is not null and rotation_z is not null
           and rotation_x between -360 and 360
           and rotation_y between -360 and 360
           and rotation_z between -360 and 360),
  add constraint artwork_layers_sort_order_range
    check (sort_order is not null and sort_order >= 0);

-- ================================================================ guard
-- Runs before every insert and update. Fails with a message an editor can
-- act on. It runs as the calling user (no SECURITY DEFINER): it reads only
-- media rows that user may already read, and a media item the user cannot
-- see counts as missing, so the check fails closed.
--
-- Every test is "(condition) is not true": true passes; false AND NULL
-- fail. A plain "if not (condition)" would let NULL through, because
-- "not NULL" is NULL and an IF treats NULL as false.

create function public.cms_guard_artwork_layer()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_media public.media;
begin
  if tg_op = 'UPDATE' and new.artwork_id is distinct from old.artwork_id then
    raise exception 'A content layer cannot be moved to another artwork.'
      using errcode = '23514';
  end if;

  if (new.layer_type in ('VIDEO', 'MODEL_3D')) is not true then
    raise exception 'A content layer must be a video or a 3D model.'
      using errcode = '23514';
  end if;

  if (new.scale >= 0.05 and new.scale <= 10) is not true then
    raise exception 'Scale must be between 0.05 and 10.'
      using errcode = '23514';
  end if;

  if (new.position_x between -5 and 5
      and new.position_y between -5 and 5
      and new.position_z between -5 and 5) is not true then
    raise exception 'Position must be between -5 and 5 on every axis (1 = the trigger width).'
      using errcode = '23514';
  end if;

  if (new.rotation_x between -360 and 360
      and new.rotation_y between -360 and 360
      and new.rotation_z between -360 and 360) is not true then
    raise exception 'Rotation must be between -360 and 360 degrees on every axis.'
      using errcode = '23514';
  end if;

  if (new.sort_order >= 0) is not true then
    raise exception 'Layer order cannot be negative or missing.'
      using errcode = '23514';
  end if;

  if new."loop" is null or new.muted is null or new.enabled is null then
    raise exception 'Loop, muted and enabled must each be on or off.'
      using errcode = '23514';
  end if;

  if new.layer_type = 'VIDEO' and (new.fit in ('target', 'video')) is not true then
    raise exception 'A video layer needs a fit: "target" or "video".'
      using errcode = '23514';
  end if;

  if new.layer_type = 'MODEL_3D' and new.fit is not null then
    raise exception 'A 3D layer has no fit.'
      using errcode = '23514';
  end if;

  -- The media checks run when the media or the layer type is set. A layer
  -- whose media is archived later can still be moved, hidden or deleted.
  if tg_op = 'INSERT'
     or new.media_id is distinct from old.media_id
     or new.layer_type is distinct from old.layer_type then
    select * into v_media from public.media where id = new.media_id;

    if not found then
      raise exception 'The selected media item does not exist.'
        using errcode = '23503';
    end if;

    if v_media.status is distinct from 'active' then
      raise exception 'The media item "%" is archived and cannot be added to an artwork.', v_media.name
        using errcode = '23514';
    end if;

    if new.layer_type = 'VIDEO'
       and (v_media.type is distinct from 'VIDEO' or v_media.video_mode is null) then
      raise exception 'A video layer needs a video from the Media Library; "%" is %.',
        v_media.name, lower(coalesce(v_media.type, 'unknown'))
        using errcode = '23514';
    end if;

    if new.layer_type = 'MODEL_3D' and v_media.type is distinct from 'MODEL_3D' then
      raise exception 'A 3D layer needs a GLB model from the Media Library; "%" is %.',
        v_media.name, lower(coalesce(v_media.type, 'unknown'))
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- Trigger functions cannot be called directly; keep them closed anyway.
revoke all on function public.cms_guard_artwork_layer() from public, anon, authenticated;

create trigger cms_guard before insert or update on public.artwork_layers
  for each row execute function public.cms_guard_artwork_layer();

commit;