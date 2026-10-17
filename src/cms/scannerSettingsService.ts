import type { ARContentConfig } from '../lib/contentService';
import { supabase } from '../lib/supabase';
import { sha256Hex } from './fileInspect';
import { scannerAssetFormatOf } from './mediaRules';
import { BUCKETS, IMMUTABLE_CACHE_CONTROL, getStorage } from './storage';
import { scannerKey } from './storageKeys';

// Uploads a scanner asset to its own content-addressed path and returns the
// URL. This never touches a file the live scanner is using: the scanner only
// sees the new file once publishScannerSettings() writes its URL.
export async function uploadScannerAsset(
  key: keyof ARContentConfig,
  file: File,
): Promise<string> {
  const checked = scannerAssetFormatOf(key, file);

  if ('error' in checked) {
    throw new Error(checked.error);
  }

  const { format } = checked;
  const storage = getStorage();
  const path = scannerKey(key, await sha256Hex(file), format.extension);

  // As for media uploads: Storage records the Blob's own type, so relabel
  // the bytes with the allowed type. The bytes and their hash are unchanged.
  const body = file.type === format.mimeType ? file : file.slice(0, file.size, format.mimeType);

  await storage.upload(BUCKETS.scanner, path, body, {
    contentType: format.mimeType,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
  });

  return storage.getPublicUrl(BUCKETS.scanner, path);
}

// The single write that changes what scanner visitors get.
export async function publishScannerSettings(config: ARContentConfig) {
  const { error } = await supabase.from('ar_content').upsert({
    id: 'main',
    config,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    throw error;
  }
}
