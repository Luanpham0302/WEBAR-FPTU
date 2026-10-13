// The release manifest: the immutable snapshot stored in releases.manifest.
//
// It is the runtime ARProfile (src/ar/types.ts) with two differences:
//   - files are storage references, not URLs, so storage can be replaced
//     without rewriting old releases;
//   - it carries the identity of the release and of the target pack.
//
// The scanner will load ONE manifest (Phase 2C) and never join CMS tables.
// targetIndex / targetWidth / targetHeight come from target_pack_items, the
// authoritative mapping written when the pack was compiled.
//
// Nothing in the scanner imports this file yet. Type-only imports keep it
// runnable under `node --test`.

import type {
  ARProfile,
  Artwork,
  LayerConfig,
  ModelLayerConfig,
  VideoLayerConfig,
} from '../ar/types';

export const MANIFEST_SCHEMA_VERSION = 1;

// The MindAR version pinned in package.json. A pack compiled by any other
// version must not be published against this runtime.
export const MINDAR_COMPILER_VERSION = '1.2.5';

export type AssetRef = {
  provider: string;
  bucket: string;
  key: string;
};

export type ManifestVideoLayer = Omit<VideoLayerConfig, 'src'> & {
  mediaId: string;
  asset: AssetRef;
};

export type ManifestModelLayer = Omit<ModelLayerConfig, 'src'> & {
  mediaId: string;
  asset: AssetRef;
};

export type ManifestLayer = ManifestVideoLayer | ManifestModelLayer;

export type ManifestArtwork = Omit<Artwork, 'layers'> & {
  layers: ManifestLayer[];
};

export type ManifestTargetPack = {
  id: string;
  version: number;
  asset: AssetRef;
  sha256: string;
  targetCount: number;
  compilerVersion: string;
};

export type ManifestTracking = {
  filterMinCF: number;
  filterBeta: number;
  warmupTolerance: number;
  missTolerance: number;
};

export type ReleaseManifest = {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  campaignId: string;
  campaignSlug: string;
  releaseId: string;
  version: number;
  createdAt: string;
  targetPack: ManifestTargetPack;
  rotateMatchOrder: boolean;
  // Absent = the built-in tracking settings.
  tracking?: ManifestTracking;
  artworks: ManifestArtwork[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isTriple = (value: unknown) =>
  Array.isArray(value) && value.length === 3 && value.every(isNumber);

const isAssetRef = (value: unknown) =>
  isObject(value) &&
  isText(value.provider) &&
  isText(value.bucket) &&
  isText(value.key);

function layerProblems(layer: unknown, where: string): string[] {
  if (!isObject(layer)) {
    return [`${where}: not an object`];
  }

  const problems: string[] = [];
  const need = (ok: boolean, field: string) => {
    if (!ok) {
      problems.push(`${where}: invalid ${field}`);
    }
  };

  need(isText(layer.mediaId), 'mediaId');
  need(isAssetRef(layer.asset), 'asset');
  need(isNumber(layer.scale) && layer.scale > 0, 'scale');
  need(isTriple(layer.position), 'position');

  if (layer.type === 'VIDEO') {
    need(
      layer.videoMode === 'normal' || layer.videoMode === 'alpha-packed',
      'videoMode',
    );
    need(layer.fit === 'target' || layer.fit === 'video', 'fit');
    need(typeof layer.loop === 'boolean', 'loop');
    need(typeof layer.muted === 'boolean', 'muted');
  } else if (layer.type === 'MODEL_3D') {
    need(isTriple(layer.rotation), 'rotation');
  } else {
    problems.push(`${where}: unknown layer type`);
  }

  return problems;
}

// Returns every problem found; an empty list means the manifest is safe to
// hand to the runtime. Used before a release is saved and again on load.
export function validateManifest(value: unknown): string[] {
  if (!isObject(value)) {
    return ['manifest is not an object'];
  }

  const problems: string[] = [];

  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    problems.push(`unsupported schemaVersion: ${String(value.schemaVersion)}`);
  }

  for (const field of ['campaignId', 'campaignSlug', 'releaseId', 'createdAt']) {
    if (!isText(value[field])) {
      problems.push(`invalid ${field}`);
    }
  }

  if (!Number.isInteger(value.version) || (value.version as number) < 1) {
    problems.push('invalid version');
  }

  if (typeof value.rotateMatchOrder !== 'boolean') {
    problems.push('invalid rotateMatchOrder');
  }

  const pack = value.targetPack;
  let targetCount = 0;

  if (!isObject(pack)) {
    problems.push('invalid targetPack');
  } else {
    if (!isText(pack.id) || !isAssetRef(pack.asset) || !isText(pack.sha256)) {
      problems.push('invalid targetPack reference');
    }

    if (!Number.isInteger(pack.version) || (pack.version as number) < 1) {
      problems.push('invalid targetPack.version');
    }

    if (!Number.isInteger(pack.targetCount) || (pack.targetCount as number) < 1) {
      problems.push('invalid targetPack.targetCount');
    } else {
      targetCount = pack.targetCount as number;
    }

    if (pack.compilerVersion !== MINDAR_COMPILER_VERSION) {
      problems.push(
        `targetPack.compilerVersion must be ${MINDAR_COMPILER_VERSION}, got ${String(pack.compilerVersion)}`,
      );
    }
  }

  if (!Array.isArray(value.artworks) || value.artworks.length === 0) {
    problems.push('artworks is empty');
    return problems;
  }

  const seenIndexes = new Set<number>();

  value.artworks.forEach((artwork: unknown, position: number) => {
    const where = `artworks[${position}]`;

    if (!isObject(artwork)) {
      problems.push(`${where}: not an object`);
      return;
    }

    if (!isText(artwork.id) || !isText(artwork.name)) {
      problems.push(`${where}: invalid id or name`);
    }

    const index = artwork.targetIndex;

    if (!Number.isInteger(index) || (index as number) < 0) {
      problems.push(`${where}: invalid targetIndex`);
    } else if (targetCount > 0 && (index as number) >= targetCount) {
      problems.push(`${where}: targetIndex ${index} is outside the target pack`);
    } else if (seenIndexes.has(index as number)) {
      problems.push(`${where}: duplicate targetIndex ${index}`);
    } else {
      seenIndexes.add(index as number);
    }

    if (
      !isNumber(artwork.targetWidth) ||
      !isNumber(artwork.targetHeight) ||
      artwork.targetWidth <= 0 ||
      artwork.targetHeight <= 0
    ) {
      problems.push(`${where}: invalid targetWidth or targetHeight`);
    }

    if (!Array.isArray(artwork.layers)) {
      problems.push(`${where}: layers is not a list`);
      return;
    }

    artwork.layers.forEach((layer: unknown, layerPosition: number) => {
      problems.push(...layerProblems(layer, `${where}.layers[${layerPosition}]`));
    });
  });

  return problems;
}

// Turns a manifest into the ARProfile the existing runtime already consumes.
// `resolveUrl` is the only place storage enters, so the runtime stays
// independent of where files live.
export function manifestToProfile(
  manifest: ReleaseManifest,
  resolveUrl: (asset: AssetRef) => string,
): ARProfile {
  return {
    id: `campaign-${manifest.campaignSlug}-v${manifest.version}`,
    targetSrc: resolveUrl(manifest.targetPack.asset),
    rotateMatchOrder: manifest.rotateMatchOrder,
    artworks: manifest.artworks.map((artwork) => ({
      id: artwork.id,
      name: artwork.name,
      targetIndex: artwork.targetIndex,
      targetWidth: artwork.targetWidth,
      targetHeight: artwork.targetHeight,
      layers: artwork.layers.map((layer): LayerConfig => {
        const { asset, mediaId: _mediaId, ...settings } = layer;

        return { ...settings, src: resolveUrl(asset) };
      }),
    })),
  };
}
