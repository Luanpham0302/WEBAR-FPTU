import type { ARContentConfig } from '../lib/contentService';
import { supabase } from '../lib/supabase';
import { sha256Hex } from './fileInspect';
import { BUCKETS, IMMUTABLE_CACHE_CONTROL, getStorage } from './storage';
import { extensionOf, scannerKey } from './storageKeys';

// Uploads a scanner asset to its own content-addressed path and returns the
// URL. This never touches a file the live scanner is using: the scanner only
// sees the new file once publishScannerSettings() writes its URL.
export async function uploadScannerAsset(
  key: keyof ARContentConfig,
  file: File,
): Promise<string> {
  const storage = getStorage();
  const path = scannerKey(
    key,
    await sha256Hex(file),
    extensionOf(file.name, file.type),
  );

  await storage.upload(BUCKETS.scanner, path, file, {
    contentType: file.type || undefined,
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
