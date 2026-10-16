import type { ArtworkLayer, Media } from './types';

// Must match the constraints in 20261015090000_cms_content_layers.sql.
export const LAYER_LIMITS = {
  scale: { min: 0.05, max: 10 },
  position: { min: -5, max: 5 },
  rotation: { min: -360, max: 360 },
  sortOrderMin: 0,
} as const;

export type LayerInput = Pick<
  ArtworkLayer,
  | 'media_id'
  | 'layer_type'
  | 'position_x'
  | 'position_y'
  | 'position_z'
  | 'scale'
  | 'rotation_x'
  | 'rotation_y'
  | 'rotation_z'
  | 'fit'
  | 'loop'
  | 'muted'
  | 'enabled'
  | 'sort_order'
>;

export function defaultLayerInput(
  type: LayerInput['layer_type'],
  mediaId = '',
  sortOrder = 0,
): LayerInput {
  return {
    media_id: mediaId,
    layer_type: type,
    position_x: 0,
    position_y: 0,
    position_z: 0,
    scale: 1,
    rotation_x: 0,
    rotation_y: 0,
    rotation_z: 0,
    fit: type === 'VIDEO' ? 'target' : null,
    loop: true,
    muted: true,
    enabled: true,
    sort_order: sortOrder,
  };
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

export function validateLayerInput(
  input: LayerInput,
  media: Pick<Media, 'id' | 'type' | 'status' | 'video_mode'> | null,
): string | null {
  if (input.layer_type !== 'VIDEO' && input.layer_type !== 'MODEL_3D') {
    return 'Choose a video or a 3D model layer.';
  }

  if (!media || media.id !== input.media_id) {
    return 'Choose a file from the Media Library.';
  }

  if (media.status !== 'active') {
    return 'The selected media is archived. Choose an active file.';
  }

  if (media.type !== input.layer_type) {
    return 'The media type must match the layer type.';
  }

  if (input.layer_type === 'VIDEO') {
    if (media.video_mode !== 'normal' && media.video_mode !== 'alpha-packed') {
      return 'The video must have a video mode configured in the Media Library.';
    }
    if (input.fit !== 'target' && input.fit !== 'video') {
      return 'Choose target or video fit.';
    }
  } else if (input.fit !== null) {
    return 'A 3D model layer cannot have a video fit.';
  }

  const { scale, position, rotation } = LAYER_LIMITS;

  if (!inRange(input.scale, scale.min, scale.max)) {
    return 'Scale must be between 0.05 and 10.';
  }

  if (![input.position_x, input.position_y, input.position_z].every(
    (value) => inRange(value, position.min, position.max),
  )) {
    return 'Position X, Y and Z must each be between -5 and 5.';
  }

  if (![input.rotation_x, input.rotation_y, input.rotation_z].every(
    (value) => inRange(value, rotation.min, rotation.max),
  )) {
    return 'Rotation X, Y and Z must each be between -360 and 360.';
  }

  if (!Number.isSafeInteger(input.sort_order) || input.sort_order < LAYER_LIMITS.sortOrderMin) {
    return 'Layer order must be a non-negative whole number.';
  }

  if (
    typeof input.loop !== 'boolean' ||
    typeof input.muted !== 'boolean' ||
    typeof input.enabled !== 'boolean'
  ) {
    return 'Layer options must be on or off.';
  }

  return null;
}
