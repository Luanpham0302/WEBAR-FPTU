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
