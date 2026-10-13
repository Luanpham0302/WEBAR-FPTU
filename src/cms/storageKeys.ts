// Storage key builders. Every key contains the content hash, so a key never
// points at different bytes and nothing is ever overwritten in place.
//
// This file has no imports on purpose: it also runs under `node --test`.

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'model/gltf-binary': 'glb',
};

// Lower-case extension without the dot. Falls back to the MIME type, then
// to 'bin', so a key always ends in something a server can map to a type.
export function extensionOf(fileName: string, mimeType = ''): string {
  const dot = fileName.lastIndexOf('.');
  const fromName = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';

  if (EXTENSION_PATTERN.test(fromName)) {
    return fromName === 'jpeg' ? 'jpg' : fromName;
  }

  return EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? 'bin';
}

function assertSegment(value: string, label: string) {
  if (!SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} for a storage key: "${value}"`);
  }
}

function assertHash(sha256: string) {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error('A storage key needs a lower-case SHA-256 hex digest.');
  }
}

function assertExtension(extension: string) {
  if (!EXTENSION_PATTERN.test(extension)) {
    throw new Error(`Invalid file extension for a storage key: "${extension}"`);
  }
}

// media/{media-id}/{sha256}.{ext}
export function mediaKey(mediaId: string, sha256: string, extension: string) {
  assertSegment(mediaId, 'media id');
  assertHash(sha256);
  assertExtension(extension);

  return `media/${mediaId}/${sha256}.${extension}`;
}

// triggers/{campaign-id}/{artwork-id}/{sha256}.{ext}
export function triggerKey(
  campaignId: string,
  artworkId: string,
  sha256: string,
  extension: string,
) {
  assertSegment(campaignId, 'campaign id');
  assertSegment(artworkId, 'artwork id');
  assertHash(sha256);
  assertExtension(extension);

  return `triggers/${campaignId}/${artworkId}/${sha256}.${extension}`;
}

// scanner/{asset-key}/{sha256}.{ext}
export function scannerKey(assetKey: string, sha256: string, extension: string) {
  assertSegment(assetKey, 'scanner asset key');
  assertHash(sha256);
  assertExtension(extension);

  return `scanner/${assetKey}/${sha256}.${extension}`;
}
