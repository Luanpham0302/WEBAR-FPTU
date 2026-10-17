// Public scanner release loader. The PoC never makes a CMS request.
// No CMS tables are fetched client-side: only the public release RPC returns
// a frozen, validated manifest. Failure to load the live CMS config falls back
// to the pre-existing legacy scanner until a release is available; a published
// manifest that cannot be used fails closed (see scannerSource.ts).
import type { ARProfile } from '../ar/types';
import { legacyProfile, pocProfile } from '../config/arProfiles';
import { supabase } from '../lib/supabase';
import { manifestToProfile, validateManifest, type AssetRef, type ReleaseManifest } from './manifest';
import { getLiveManifest, getPrivatePreviewManifest } from './releaseService';
import { chooseScannerProfile } from './scannerSource';

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

export function loadScannerProfile(search: string): Promise<ARProfile> {
  return chooseScannerProfile<ARProfile>(search, {
    poc: pocProfile,
    legacy: legacyProfile,
    fetchLive: getLiveManifest,
    fetchPreview: getPrivatePreviewManifest,
    toProfile: profileFromManifest,
    onLiveUnavailable: (error) => console.warn('Live CMS release unavailable; using legacy scanner.', error),
  });
}
