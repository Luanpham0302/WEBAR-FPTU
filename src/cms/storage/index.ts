import { supabase } from '../../lib/supabase';
import type { ObjectRef, StorageAdapter } from './StorageAdapter';
import { SupabaseStorageAdapter } from './SupabaseStorageAdapter';

export type {
  ObjectInfo,
  ObjectRef,
  StorageAdapter,
  UploadOptions,
  UploadResult,
} from './StorageAdapter';

// Logical buckets. A future adapter maps these names to its own containers.
export const BUCKETS = {
  // Existing bucket; holds the scanner branding assets.
  scanner: 'ar-assets',
  // Public CMS media: videos, models, images.
  media: 'ar-media',
  // Private trigger source images.
  sources: 'ar-sources',
} as const;

const PUBLIC_BUCKETS = new Set<string>([BUCKETS.scanner, BUCKETS.media]);

// Keys contain the content hash, so a stored object never changes.
export const IMMUTABLE_CACHE_CONTROL = '31536000';

const SIGNED_URL_SECONDS = 60 * 60;

// To move to company storage: add its adapter here and change ACTIVE_PROVIDER.
// Rows written earlier keep their own provider and still resolve.
const adapters: Record<string, StorageAdapter> = {
  supabase: new SupabaseStorageAdapter(supabase),
};

export const ACTIVE_PROVIDER = 'supabase';

export function getStorage(provider: string = ACTIVE_PROVIDER): StorageAdapter {
  const adapter = adapters[provider];

  if (!adapter) {
    throw new Error(`No storage adapter is registered for "${provider}".`);
  }

  return adapter;
}

export function isPublicBucket(bucket: string): boolean {
  return PUBLIC_BUCKETS.has(bucket);
}

// A URL the signed-in admin can display: public for public buckets, signed
// and short-lived for private ones.
export async function resolveObjectUrl(ref: ObjectRef): Promise<string> {
  const storage = getStorage(ref.provider);

  return isPublicBucket(ref.bucket)
    ? storage.getPublicUrl(ref.bucket, ref.key)
    : storage.getSignedUrl(ref.bucket, ref.key, SIGNED_URL_SECONDS);
}
