// Target pack logic that needs no browser and no database: ordering the
// compiler input, reading the compiler output, verifying one against the
// other, grading tracking quality.
//
// Only type imports, so it also runs under `node --test`.
//
// THE RULE THIS FILE PROTECTS: a targetIndex is the position of an image in
// the list handed to the MindAR compiler. That list is built once, by
// orderCompileSources(), before the compile. Everything afterwards (the
// verification, target_pack_items, later the release manifest) is derived
// from that same list or from target_pack_items. Nothing re-sorts artworks
// to work out an index after a compile.

import type { ARProfile, LayerConfig } from '../ar/types';

export type CompileSource = {
  targetIndex: number;
  artworkId: string;
  artworkName: string;
  triggerMediaId: string;
  sha256: string;
  width: number;
  height: number;
};

type SourceArtwork = {
  id: string;
  name: string;
  status: string;
  sort_order: number;
  created_at: string;
  trigger_media_id: string | null;
  trigger_sha256: string | null;
  trigger_width: number | null;
  trigger_height: number | null;
};

// The compiler input, in order. Only Ready artworks are compiled. Ties on
// sort_order are broken by creation time and then id, so the order is the
// same for every editor and every run.
export function orderCompileSources(artworks: SourceArtwork[]): CompileSource[] {
  return artworks
    .filter(
      (artwork) =>
        artwork.status === 'ready' &&
        artwork.trigger_media_id !== null &&
        artwork.trigger_sha256 !== null &&
        artwork.trigger_width !== null &&
        artwork.trigger_height !== null,
    )
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    )
    .map((artwork, targetIndex) => ({
      targetIndex,
      artworkId: artwork.id,
      artworkName: artwork.name,
      triggerMediaId: artwork.trigger_media_id as string,
      sha256: artwork.trigger_sha256 as string,
      width: artwork.trigger_width as number,
      height: artwork.trigger_height as number,
    }));
}

// Identifies "these images, in this order, with this compiler". Two packs
// with the same source hash would be interchangeable.
export async function computeSourceHash(
  sources: CompileSource[],
  compilerVersion: string,
): Promise<string> {
  const text = [
    `mind-ar@${compilerVersion}`,
    ...sources.map(
      (source) =>
        `${source.targetIndex}:${source.sha256}:${source.width}x${source.height}`,
    ),
  ].join('\n');

  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

// What the compiler produced for one target, read back from the .mind data.
export type CompiledTarget = {
  width: number;
  height: number;
  // Number of image scales that have matching features.
  matchingScales: number;
  // Feature points at the largest scale. MindAR caps this at 500.
  matchingPointsLargest: number;
  // Feature points over all scales: what detection has to work with.
  matchingPoints: number;
  // Points per tracking level: what keeps the overlay locked on.
  trackingPoints: number[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const lengthOf = (value: unknown) => (Array.isArray(value) ? value.length : 0);

// Reads the decoded `dataList` of a .mind file (the same structure
// tools/inspect-targets.mjs prints). Throws if it is not one.
export function summarizeTargets(dataList: unknown): CompiledTarget[] {
  if (!Array.isArray(dataList)) {
    throw new Error('The compiled file has no target list.');
  }

  return dataList.map((target: unknown, index) => {
    if (
      !isObject(target) ||
      !isObject(target.targetImage) ||
      !Array.isArray(target.matchingData) ||
      !Array.isArray(target.trackingData)
    ) {
      throw new Error(`Target ${index} in the compiled file is incomplete.`);
    }

    const perScale = target.matchingData.map((keyframe: unknown) =>
      isObject(keyframe)
        ? lengthOf(keyframe.maximaPoints) + lengthOf(keyframe.minimaPoints)
        : 0,
    );

    return {
      width: Number(target.targetImage.width),
      height: Number(target.targetImage.height),
      matchingScales: perScale.length,
      matchingPointsLargest: perScale[0] ?? 0,
      matchingPoints: perScale.reduce((sum, count) => sum + count, 0),
      trackingPoints: target.trackingData.map((level: unknown) =>
        isObject(level) ? lengthOf(level.points) : 0,
      ),
    };
  });
}

// Compares the compiler output with its input, target by target. An empty
// list means the file is safe to store. Run before any upload.
export function verifyCompiledTargets(
  sources: CompileSource[],
  targets: CompiledTarget[],
): string[] {
  const problems: string[] = [];

  if (sources.length === 0) {
    problems.push('There were no trigger images to compile.');
  }

  if (targets.length !== sources.length) {
    problems.push(
      `The compiled file has ${targets.length} targets but ${sources.length} images were compiled.`,
    );
    return problems;
  }

  sources.forEach((source, position) => {
    const target = targets[position];
    const label = `Target ${position} (${source.artworkName})`;

    if (source.targetIndex !== position) {
      problems.push(`${label}: the source list is out of order.`);
    }

    if (target.width !== source.width || target.height !== source.height) {
      problems.push(
        `${label}: compiled as ${target.width} x ${target.height} but the trigger is ${source.width} x ${source.height}.`,
      );
    }

    if (target.matchingScales === 0 || target.matchingPoints === 0) {
      problems.push(`${label}: the compiler found no features to detect.`);
    }

    if (
      target.trackingPoints.length === 0 ||
      target.trackingPoints.every((count) => count === 0)
    ) {
      problems.push(`${label}: the compiler found no points to track.`);
    }
  });

  return problems;
}

// The largest pack that can be stored: 50 MB. It is the Supabase Storage
// upload limit (the project default, and the maximum on the Free plan), not
// a MindAR limit. Must equal public.cms_pack_max_bytes() in the database,
// which refuses a larger reservation.
export const MAX_PACK_BYTES = 50 * 1024 * 1024;

// The problem with a compiled pack of this size, or null when it fits.
export function checkPackSize(bytes: number): string | null {
  if (bytes <= MAX_PACK_BYTES) {
    return null;
  }

  const megabytes = (value: number) => (value / (1024 * 1024)).toFixed(1);

  return `The compiled pack is ${megabytes(bytes)} MB. The largest pack that can be stored is ${megabytes(MAX_PACK_BYTES)} MB. Set some artworks to Draft or use smaller trigger images, then compile again.`;
}

// Compares what storage actually returned with what was compiled. Returns
// the problem, or null when the stored file is the compiled file.
//
// This is the only place the CONTENT of a stored pack is checked today, and
// it runs in the browser of the person who compiled it. The database checks
// that a file exists with the right size, not what is in it. A file of the
// right size with different bytes is caught here and nowhere else, so this
// is a safeguard against accidents (a truncated or mixed-up upload), not a
// control against a hostile editor. Phase 2C needs a server-side check.
export function checkStoredPack(
  expected: { sha256: string; fileSize: number },
  actual: { sha256: string; size: number },
): string | null {
  if (actual.size !== expected.fileSize) {
    return `The stored pack is ${actual.size} bytes, but ${expected.fileSize} bytes were compiled.`;
  }

  if (actual.sha256 !== expected.sha256) {
    return 'The stored pack has the right size but different contents from the compiled file.';
  }

  return null;
}

export type QualityGrade = 'good' | 'fair' | 'poor';

export type TargetQuality = {
  grade: QualityGrade;
  reasons: string[];
};

// Heuristic bands, calibrated on the nine targets already in production use
// (2,150 to 4,800 matching points and 23 to 51 tracking points, all of which
// track well). They are guidance for editors, not MindAR limits.
export const QUALITY_BANDS = {
  matchingGood: 2000,
  matchingFair: 800,
  trackingGood: 20,
  trackingFair: 10,
} as const;

export function gradeTarget(target: CompiledTarget): TargetQuality {
  const bands = QUALITY_BANDS;
  const tracking = target.trackingPoints[0] ?? 0;
  const reasons: string[] = [];

  const matchingGrade: QualityGrade =
    target.matchingPoints >= bands.matchingGood
      ? 'good'
      : target.matchingPoints >= bands.matchingFair
        ? 'fair'
        : 'poor';
  const trackingGrade: QualityGrade =
    tracking >= bands.trackingGood
      ? 'good'
      : tracking >= bands.trackingFair
        ? 'fair'
        : 'poor';

  if (matchingGrade !== 'good') {
    reasons.push(
      `Few detection features (${target.matchingPoints}). The image needs more fine, high-contrast detail.`,
    );
  }

  if (trackingGrade !== 'good') {
    reasons.push(
      `Few tracking points (${tracking}). The overlay may jitter or drop out.`,
    );
  }

  const order: QualityGrade[] = ['good', 'fair', 'poor'];
  const grade =
    order[Math.max(order.indexOf(matchingGrade), order.indexOf(trackingGrade))];

  return { grade, reasons };
}

// Same bands, from the single number kept in target_pack_items.
export function gradeFeatureCount(featureCount: number | null): QualityGrade | null {
  if (featureCount === null) {
    return null;
  }

  if (featureCount >= QUALITY_BANDS.matchingGood) {
    return 'good';
  }

  return featureCount >= QUALITY_BANDS.matchingFair ? 'fair' : 'poor';
}

export type PackItemInput = {
  target_index: number;
  artwork_id: string;
  trigger_media_id: string;
  trigger_sha256: string;
  width: number;
  height: number;
  feature_count: number;
};

// The rows for target_pack_items: the compile input list, with the size the
// compiler embedded. Call only after verifyCompiledTargets() returned [].
export function buildPackItems(
  sources: CompileSource[],
  targets: CompiledTarget[],
): PackItemInput[] {
  if (verifyCompiledTargets(sources, targets).length > 0) {
    throw new Error('Pack items can only be built from a verified compile.');
  }

  return sources.map((source, position) => ({
    target_index: position,
    artwork_id: source.artworkId,
    trigger_media_id: source.triggerMediaId,
    trigger_sha256: source.sha256,
    width: targets[position].width,
    height: targets[position].height,
    feature_count: targets[position].matchingPoints,
  }));
}

type ProfileItem = {
  target_index: number;
  artwork_id: string;
  width: number;
  height: number;
  artwork: { id: string; name: string } | null;
};

type ProfileLayer = {
  artwork_id: string;
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
  media: {
    storage_provider: string;
    bucket: string;
    storage_key: string;
    video_mode: 'normal' | 'alpha-packed' | null;
    status: string;
  } | null;
};

type AssetRef = { provider: string; bucket: string; key: string };

// A runtime profile for testing one pack. targetIndex, targetWidth and
// targetHeight come from target_pack_items and from nowhere else.
export function buildPackProfile(input: {
  pack: {
    id: string;
    version: number;
    storage_provider: string;
    bucket: string;
    storage_key: string;
  };
  rotateMatchOrder: boolean;
  items: ProfileItem[];
  layers: ProfileLayer[];
  resolveUrl: (asset: AssetRef) => string;
}): ARProfile {
  const { pack, items, layers, resolveUrl } = input;

  return {
    id: `pack-test-${pack.id}`,
    targetSrc: resolveUrl({
      provider: pack.storage_provider,
      bucket: pack.bucket,
      key: pack.storage_key,
    }),
    rotateMatchOrder: input.rotateMatchOrder,
    artworks: [...items]
      .sort((a, b) => a.target_index - b.target_index)
      .map((item) => ({
        id: item.artwork_id,
        name: item.artwork?.name ?? `Target ${item.target_index}`,
        targetIndex: item.target_index,
        targetWidth: item.width,
        targetHeight: item.height,
        layers: layers
          .filter(
            (layer) =>
              layer.artwork_id === item.artwork_id &&
              layer.enabled &&
              layer.media !== null &&
              layer.media.status === 'active',
          )
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((layer): LayerConfig => {
            const media = layer.media as NonNullable<ProfileLayer['media']>;
            const src = resolveUrl({
              provider: media.storage_provider,
              bucket: media.bucket,
              key: media.storage_key,
            });
            const position: [number, number, number] = [
              layer.position_x,
              layer.position_y,
              layer.position_z,
            ];

            if (layer.layer_type === 'MODEL_3D') {
              return {
                type: 'MODEL_3D',
                src,
                scale: layer.scale,
                position,
                rotation: [layer.rotation_x, layer.rotation_y, layer.rotation_z],
              };
            }

            return {
              type: 'VIDEO',
              src,
              videoMode: media.video_mode ?? 'normal',
              fit: layer.fit ?? 'video',
              scale: layer.scale,
              position,
              loop: layer.loop,
              muted: layer.muted,
            };
          }),
      })),
  };
}
