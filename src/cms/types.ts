// Row shapes of the CMS tables, as PostgREST returns them.

import type { VideoMode } from '../ar/types';

export type { CmsRole } from './validation';

export type CampaignStatus = 'active' | 'archived';

export type Campaign = {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: CampaignStatus;
  rotate_match_order: boolean;
  tracking: Record<string, unknown>;
  live_release_id: string | null;
  created_at: string;
  updated_at: string;
};

export type MediaType = 'VIDEO' | 'MODEL_3D' | 'IMAGE' | 'TRIGGER';

// The types a person uploads from the Media Library. A TRIGGER is uploaded
// from its artwork, because its storage path contains the artwork.
export type LibraryMediaType = Exclude<MediaType, 'TRIGGER'>;

export type MediaStatus = 'active' | 'archived';

export type Media = {
  id: string;
  name: string;
  type: MediaType;
  storage_provider: string;
  bucket: string;
  storage_key: string;
  sha256: string;
  mime_type: string;
  file_size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  video_mode: VideoMode | null;
  status: MediaStatus;
  created_at: string;
  updated_at: string;
};

export type ArtworkStatus = 'draft' | 'ready' | 'archived';

export type Artwork = {
  id: string;
  campaign_id: string;
  name: string;
  description: string;
  category: string;
  trigger_media_id: string | null;
  trigger_width: number | null;
  trigger_height: number | null;
  trigger_sha256: string | null;
  status: ArtworkStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

// An artwork with its trigger media row, for lists that show the image.
export type ArtworkWithTrigger = Artwork & {
  trigger: Media | null;
};

export type TargetPackStatus = 'uploaded' | 'verified' | 'failed' | 'retired';

export type TargetPack = {
  id: string;
  campaign_id: string;
  version: number;
  storage_provider: string;
  bucket: string;
  storage_key: string;
  sha256: string;
  file_size: number;
  target_count: number;
  source_hash: string;
  compiler_version: string;
  status: TargetPackStatus;
  created_at: string;
  created_by: string | null;
};

// One row of the authoritative targetIndex mapping of a pack.
export type TargetPackItem = {
  pack_id: string;
  target_index: number;
  artwork_id: string;
  trigger_media_id: string;
  trigger_sha256: string;
  width: number;
  height: number;
  feature_count: number | null;
};

export type TargetPackItemWithArtwork = TargetPackItem & {
  artwork: { id: string; name: string } | null;
};

export type ArtworkLayer = {
  id: string;
  artwork_id: string;
  media_id: string;
  layer_type: 'VIDEO' | 'MODEL_3D';
  position_x: number;
  position_y: number;
  position_z: number;
  scale: number;
  rotation_x: number;
  rotation_y: number;
  rotation_z: number;
  fit: 'target' | 'video' | null;
  loop: boolean;
  muted: boolean;
  enabled: boolean;
  sort_order: number;
};

export type ArtworkLayerWithMedia = ArtworkLayer & {
  media: Media | null;
};
