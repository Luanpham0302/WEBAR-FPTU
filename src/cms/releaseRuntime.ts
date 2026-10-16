// Public scanner release loader. The PoC never makes a CMS request.
// No CMS tables are fetched client-side: only the public release RPC returns
// a frozen, validated manifest. Failure to load the live CMS config falls back
// to the pre-existing legacy scanner until a release is available.
import type { ARProfile } from '../ar/types';
import { legacyProfile, pocProfile } from '../config/arProfiles';
import { supabase } from '../lib/supabase';
import { manifestToProfile, validateManifest, type AssetRef, type ReleaseManifest } from './manifest';
import { getLiveManifest, getPrivatePreviewManifest } from './releaseService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function profileFromManifest(value: unknown): ARProfile {
  const problems = validateManifest(value);
  if (problems.length > 0) {
    throw new Error('Invalid release manifest: ' + problems.join('; '));
  }
  const manifest = value as ReleaseManifest;
  if (manifest.artworks.length !== manifest.targetPack.targetCount) {
    throw new Error('Release manifest target count does not match its artworks.');
  }

  // An untrusted/old manifest must never inject arbitrary bucket paths.
  const resolve = (asset: AssetRef) => {
    if (asset.provider !== 'supabase' || asset.bucket !== 'ar-media'
        || !(/^(media|targets)\/[a-zA-Z0-9/_-]+\.(mp4|webm|mov|glb|mind)$/.test(asset.key)
             || /^media\/[0-9a-f-]+\/[0-9a-f]{64}\.(mp4|webm|mov|glb)$/.test(asset.key))) {
      throw new Error('Release contains an unsupported or unsafe media reference.');
    }
    return supabase.storage.from(asset.bucket).getPublicUrl(asset.key).data.publicUrl;
  };
  return manifestToProfile(manifest, resolve);
}

export async function loadScannerProfile(search: string): Promise<ARProfile> {
  const params = new URLSearchParams(search);
  if (params.get('profile') === 'poc') return pocProfile;

  // Preview is private; fail closed rather than displaying an unrelated live
  // campaign or the legacy profile when the token is invalid.
  const preview = params.get('preview');
  if (preview !== null) {
    if (!UUID.test(preview)) throw new Error('Invalid preview token.');
    return profileFromManifest(await getPrivatePreviewManifest(preview));
  }

  try {
    const published = await getLiveManifest();
    return published ? profileFromManifest(published) : legacyProfile;
  } catch (error) {
    // Only server read/connection errors should fall back. A published
    // manifest with an unsupported schema must be surfaced as a failure,
    // never silently replaced by another published content set.
    if (error instanceof Error && (
      error.message.startsWith('Invalid release manifest:')
      || error.message.startsWith('Release manifest target count')
      || error.message.startsWith('Release contains an unsupported')
    )) {
      throw error;
    }
    console.warn('Live CMS release unavailable; using legacy scanner.', error);
    return legacyProfile;
  }
}
