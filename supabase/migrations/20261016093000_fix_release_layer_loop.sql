-- Phase 2C.2 hotfix for Staging: fix video loop field in the Release builder.
-- Original 20261016090000 migration already ran. Apply only this follow-up.
-- Fix: select explicit layer columns and alias the quoted "loop" field.
-- Retains SECURITY DEFINER, existing function ownership, grants and RLS.
-- No existing release or CMS data is changed.
begin;

do $$
begin
  if to_regprocedure('public.cms_create_release(uuid,text)') is null then
    raise exception 'Phase 2C.2 must be installed before this patch.';
  end if;
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'artwork_layers'
      and column_name = 'loop' and data_type = 'boolean'
  ) then
    raise exception 'The expected public.artwork_layers.loop column is missing.';
  end if;
end
$$;

create or replace function public.cms_create_release(p_pack_id uuid, p_notes text default '')
returns public.releases language plpgsql security definer set search_path = ''
as $$
declare
  v_pack public.target_packs;
  v_campaign public.campaigns;
  v_item record;
  v_layer record;
  v_items_count integer := 0;
  v_artworks jsonb := '[]'::jsonb;
  v_layers jsonb;
  v_layer_json jsonb;
  v_manifest jsonb;
  v_release public.releases;
  v_release_id uuid := gen_random_uuid();
  v_version integer;
  v_now timestamptz := now();
begin
  if not public.cms_has_role('editor') then
    raise exception 'Only an Editor or Admin can create a release.'
      using errcode = '42501';
  end if;
  if p_pack_id is null then
    raise exception 'Choose a target pack.' using errcode = '22023';
  end if;
  if length(coalesce(p_notes, '')) > 2000 then
    raise exception 'Release notes must be 2000 characters or fewer.'
      using errcode = '22023';
  end if;

  -- Lock the campaign to serialize release version assignment.
  select c.* into v_campaign from public.campaigns c
    join public.target_packs p on p.campaign_id = c.id
    where p.id = p_pack_id for update of c;
  if not found then
    raise exception 'Campaign or target pack not found.' using errcode = 'P0002';
  end if;
  if v_campaign.status <> 'active' then
    raise exception 'Cannot release an archived campaign.' using errcode = '23514';
  end if;

  select * into v_pack from public.target_packs where id = p_pack_id for share;
  if v_pack.status is distinct from 'verified'
     or v_pack.compiler_version <> '1.2.5'
     or v_pack.storage_provider <> 'supabase'
     or v_pack.bucket <> 'ar-media'
     or not exists (
       select 1 from public.cms_trusted_pack_checks ck
       where ck.pack_id = v_pack.id
         and ck.sha256 = v_pack.sha256
         and ck.verifier_version = 'mind-ar@1.2.5'
     ) then
    raise exception 'This pack must pass trusted MindAR verification first.'
      using errcode = '23514';
  end if;

  -- Source index and dimensions are frozen in target_pack_items, not
  -- recalculated from today's Ready/Draft artwork order.
  for v_item in
    select i.*, a.name
      from public.target_pack_items i
      join public.artworks a on a.id = i.artwork_id
     where i.pack_id = p_pack_id
     order by i.target_index
  loop
    if v_item.target_index <> v_items_count then
      raise exception 'Pack indices must be contiguous, starting from zero.'
        using errcode = '23514';
    end if;
    v_items_count := v_items_count + 1;
    v_layers := '[]'::jsonb;

    for v_layer in
      select l.layer_type, l.media_id, l.scale,
             l.position_x, l.position_y, l.position_z,
             l.rotation_x, l.rotation_y, l.rotation_z,
             l.fit, l."loop" as layer_loop, l.muted as layer_muted,
             m.type as media_type, m.status as media_status,
             m.video_mode as media_video_mode,
             m.storage_provider as media_provider,
             m.bucket as media_bucket, m.storage_key as media_key
        from public.artwork_layers l
        join public.media m on m.id = l.media_id
       where l.artwork_id = v_item.artwork_id and l.enabled
       order by l.sort_order, l.created_at, l.id
    loop
      if v_layer.media_status <> 'active'
         or v_layer.media_type <> v_layer.layer_type
         or v_layer.media_provider <> 'supabase'
         or v_layer.media_bucket <> 'ar-media' then
        raise exception 'An enabled layer uses unsupported or archived media.'
          using errcode = '23514';
      end if;

      v_layer_json := jsonb_build_object(
        'type', v_layer.layer_type,
        'mediaId', v_layer.media_id,
        'asset', jsonb_build_object(
          'provider', v_layer.media_provider,
          'bucket', v_layer.media_bucket,
          'key', v_layer.media_key
        ),
        'scale', v_layer.scale,
        'position', jsonb_build_array(
          v_layer.position_x, v_layer.position_y, v_layer.position_z
        )
      );

      if v_layer.layer_type = 'VIDEO' then
        if v_layer.media_video_mode not in ('normal', 'alpha-packed')
           or v_layer.fit not in ('target', 'video') then
          raise exception 'Invalid video layer.' using errcode = '23514';
        end if;
        v_layer_json := v_layer_json || jsonb_build_object(
          'videoMode', v_layer.media_video_mode,
          'fit', v_layer.fit,
          'loop', v_layer.layer_loop,
          'muted', v_layer.layer_muted
        );
      elsif v_layer.layer_type = 'MODEL_3D' then
        v_layer_json := v_layer_json || jsonb_build_object(
          'rotation', jsonb_build_array(
            v_layer.rotation_x, v_layer.rotation_y, v_layer.rotation_z
          )
        );
      else
        raise exception 'Unsupported layer type.' using errcode = '23514';
      end if;

      v_layers := v_layers || jsonb_build_array(v_layer_json);
    end loop;

    v_artworks := v_artworks || jsonb_build_array(jsonb_build_object(
      'id', v_item.artwork_id,
      'name', v_item.name,
      'targetIndex', v_item.target_index,
      'targetWidth', v_item.width,
      'targetHeight', v_item.height,
      'layers', v_layers
    ));
  end loop;

  if v_items_count <> v_pack.target_count then
    raise exception 'Target pack contains an incomplete item mapping.'
      using errcode = '23514';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
    from public.releases where campaign_id = v_campaign.id;

  v_manifest := jsonb_build_object(
    'schemaVersion', 1,
    'campaignId', v_campaign.id,
    'campaignSlug', v_campaign.slug,
    'releaseId', v_release_id,
    'version', v_version,
    'createdAt', v_now,
    'rotateMatchOrder', v_campaign.rotate_match_order,
    'targetPack', jsonb_build_object(
      'id', v_pack.id, 'version', v_pack.version,
      'asset', jsonb_build_object(
        'provider', v_pack.storage_provider,
        'bucket', v_pack.bucket,
        'key', v_pack.storage_key
      ),
      'sha256', v_pack.sha256,
      'targetCount', v_pack.target_count,
      'compilerVersion', v_pack.compiler_version
    ),
    'artworks', v_artworks
  );

  insert into public.releases (
    id, campaign_id, version, target_pack_id, manifest, notes
  ) values (
    v_release_id, v_campaign.id, v_version, p_pack_id,
    v_manifest, coalesce(p_notes, '')
  ) returning * into v_release;

  return v_release;
end
$$;

-- Stop if unexpected privileges were introduced.
do $$
begin
  if has_function_privilege('anon', 'public.cms_create_release(uuid,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.cms_create_release(uuid,text)', 'EXECUTE') then
    raise exception 'Release function privilege check failed. Rolling back.';
  end if;
end
$$;

commit;
