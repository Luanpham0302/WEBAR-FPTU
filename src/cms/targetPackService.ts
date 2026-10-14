import { supabase } from '../lib/supabase';
import { sha256Hex } from './fileInspect';
import {
  ACTIVE_PROVIDER,
  BUCKETS,
  IMMUTABLE_CACHE_CONTROL,
  getStorage,
} from './storage';
import { targetPackKey } from './storageKeys';
import type { CompiledPack } from './targetCompiler';
import { buildPackItems, checkStoredPack } from './targetPack';
import type {
  ArtworkLayerWithMedia,
  Campaign,
  TargetPack,
  TargetPackItemWithArtwork,
  TargetPackStatus,
} from './types';

// A pack still 'uploaded' after this long was abandoned (tab closed, network
// lost). A normal save takes seconds.
export const INTERRUPTED_AFTER_MS = 10 * 60 * 1000;

export const isInterrupted = (pack: TargetPack, now = Date.now()) =>
  pack.status === 'uploaded' &&
  now - new Date(pack.created_at).getTime() > INTERRUPTED_AFTER_MS;

export async function listTargetPacks(campaignId: string): Promise<TargetPack[]> {
  const { data, error } = await supabase
    .from('target_packs')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('version', { ascending: false });

  if (error) {
    throw error;
  }

  return data as TargetPack[];
}

export async function listPackItems(
  packId: string,
): Promise<TargetPackItemWithArtwork[]> {
  const { data, error } = await supabase
    .from('target_pack_items')
    .select('*, artwork:artworks(id, name)')
    .eq('pack_id', packId)
    .order('target_index');

  if (error) {
    throw error;
  }

  return data as unknown as TargetPackItemWithArtwork[];
}

// Packs cannot be written directly: row level security refuses it. Every
// change goes through a database function that validates it.

// 'failed' (an abandoned upload), 'retired', or 'verified' to undo a retire.
// The database decides whether the move is allowed, including whether a
// release still uses the pack.
export async function setPackStatus(
  id: string,
  status: Exclude<TargetPackStatus, 'uploaded'>,
) {
  const { error } = await supabase.rpc('cms_set_target_pack_status', {
    p_pack_id: id,
    p_status: status,
  });

  if (error) {
    throw error;
  }
}

// Asks the database to mark a freshly uploaded pack verified. The database
// checks that the caller reserved the pack, that the file is in storage at
// the reserved path with the reserved size, and that every item is present.
// It does NOT check the contents of the file: see checkStoredPack().
async function verifyPack(id: string): Promise<TargetPack> {
  const { data, error } = await supabase.rpc('cms_verify_target_pack', {
    p_pack_id: id,
  });

  if (error) {
    throw error;
  }

  return data as TargetPack;
}

export type SaveStep = 'reserving' | 'uploading' | 'verifying' | 'done';

const FUNCTION_MISSING_CODES = new Set(['PGRST202', '42883']);

// Stores a compiled pack. Order matters:
//   1. reserve  - the database validates the mapping, hands out the version
//                 and writes the pack row with its targetIndex mapping
//   2. upload   - to the path of that version, the only path storage will
//                 accept from this user; never overwrites
//   3. verify   - download what visitors would get and compare size and
//                 hash (the only content check; it runs in this browser)
//   4. the database checks that the file is present with the right size
//      and marks the pack verified
// "verified" is therefore not proof that a pack is safe to publish. Phase 2C
// must add a trusted server-side check of the stored bytes before publish.
// If 2-4 fail the pack is marked failed. A failed or abandoned pack is never
// offered for testing or release. Nothing here touches a live campaign.
export async function saveCompiledPack(
  campaignId: string,
  compiled: CompiledPack,
  onStep: (step: SaveStep) => void,
): Promise<TargetPack> {
  onStep('reserving');

  const { data, error } = await supabase.rpc('cms_reserve_target_pack', {
    p_campaign_id: campaignId,
    p_storage_provider: ACTIVE_PROVIDER,
    p_bucket: BUCKETS.media,
    p_sha256: compiled.sha256,
    p_file_size: compiled.bytes.byteLength,
    p_source_hash: compiled.sourceHash,
    p_compiler_version: compiled.compilerVersion,
    p_items: buildPackItems(compiled.sources, compiled.targets),
  });

  if (error) {
    throw FUNCTION_MISSING_CODES.has(error.code)
      ? new Error(
          'Target packs cannot be saved yet: the Phase 2B database migration (20261014090000_cms_target_packs.sql) has not been applied.',
        )
      : error;
  }

  const pack = data as TargetPack;

  try {
    if (pack.storage_key !== targetPackKey(campaignId, pack.version)) {
      throw new Error('The database returned an unexpected storage path.');
    }

    const storage = getStorage(pack.storage_provider);

    onStep('uploading');

    const upload = await storage.upload(
      pack.bucket,
      pack.storage_key,
      new Blob([compiled.bytes.slice()], { type: 'application/octet-stream' }),
      {
        contentType: 'application/octet-stream',
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      },
    );

    // The version was reserved for this pack alone, so a file already at
    // its path is not ours. It must not be adopted.
    if (upload.alreadyExisted) {
      throw new Error(
        `A file already exists at ${pack.storage_key}. The pack was not saved.`,
      );
    }

    onStep('verifying');

    const response = await fetch(
      storage.getPublicUrl(pack.bucket, pack.storage_key),
      { cache: 'no-store' },
    );

    if (!response.ok) {
      throw new Error('The uploaded pack could not be read back from storage.');
    }

    const stored = await response.blob();
    const problem = checkStoredPack(
      { sha256: pack.sha256, fileSize: pack.file_size },
      { sha256: await sha256Hex(stored), size: stored.size },
    );

    if (problem) {
      throw new Error(problem);
    }

    const verified = await verifyPack(pack.id);

    onStep('done');

    return verified;
  } catch (failure) {
    // Best effort: if this also fails the pack stays 'uploaded' and the
    // screen offers "Mark failed" once it counts as interrupted.
    await setPackStatus(pack.id, 'failed').catch(() => undefined);
    throw failure;
  }
}

export type PackTestData = {
  pack: TargetPack;
  campaign: Campaign;
  items: TargetPackItemWithArtwork[];
  layers: ArtworkLayerWithMedia[];
};

// Everything the pack tester needs. Read with the signed-in session, so row
// level security applies: an anonymous visitor gets nothing.
export async function loadPackTestData(packId: string): Promise<PackTestData> {
  const { data: pack, error: packError } = await supabase
    .from('target_packs')
    .select('*')
    .eq('id', packId)
    .maybeSingle();

  if (packError) {
    throw packError;
  }

  if (!pack) {
    throw new Error('This target pack does not exist, or you cannot see it.');
  }

  const items = await listPackItems(packId);

  const [campaign, layers] = await Promise.all([
    supabase.from('campaigns').select('*').eq('id', pack.campaign_id).single(),
    supabase
      .from('artwork_layers')
      .select('*, media:media(*)')
      .in('artwork_id', items.map((item) => item.artwork_id)),
  ]);

  if (campaign.error) {
    throw campaign.error;
  }

  if (layers.error) {
    throw layers.error;
  }

  return {
    pack: pack as TargetPack,
    campaign: campaign.data as Campaign,
    items,
    layers: layers.data as unknown as ArtworkLayerWithMedia[],
  };
}

// Feature count of each trigger in the newest verified pack, by trigger
// hash. Lets the artwork editor show how a trigger scored last time.
export async function loadLatestQuality(
  campaignId: string,
): Promise<{ version: number; bySha256: Map<string, number | null> } | null> {
  const { data: pack, error } = await supabase
    .from('target_packs')
    .select('id, version')
    .eq('campaign_id', campaignId)
    .eq('status', 'verified')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!pack) {
    return null;
  }

  const items = await listPackItems(pack.id);

  return {
    version: pack.version,
    bySha256: new Map(
      items.map((item) => [item.trigger_sha256, item.feature_count]),
    ),
  };
}
