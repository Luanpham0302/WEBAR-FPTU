// Which files the Media Library may store in the public ar-media bucket, and
// which files Scanner Settings may store in the public ar-assets bucket.
// Pure: no runtime imports, so it also runs under `node --test`.
//
// Must match 20261017120000_cms_storage_hardening.sql: the bucket allowlist
// (AR_MEDIA_ALLOWED_MIME_TYPES), the bucket size limit (AR_MEDIA_MAX_BYTES)
// and the path rule in cms_ar_media_path_kind() (the extensions below).
// The scanner asset rules at the end must match
// 20261017180000_cms_live_asset_protection.sql.
//
// The browser's File.type is a claim, not a check of the bytes. These rules
// decide which type a stored file is served with; they do not prove what is
// inside it.

import type { ARContentConfig } from '../lib/contentService';

export type LibraryFormat = {
  // Extension used in the storage key.
  extension: string;
  // File-name extensions that map to it.
  names: readonly string[];
  // The one type the file is stored and served with.
  mimeType: string;
};

export const MEDIA_FORMATS = {
  VIDEO: [
    { extension: 'mp4', names: ['mp4'], mimeType: 'video/mp4' },
    { extension: 'webm', names: ['webm'], mimeType: 'video/webm' },
  ],
  MODEL_3D: [
    { extension: 'glb', names: ['glb'], mimeType: 'model/gltf-binary' },
  ],
  IMAGE: [
    { extension: 'png', names: ['png'], mimeType: 'image/png' },
    { extension: 'jpg', names: ['jpg', 'jpeg'], mimeType: 'image/jpeg' },
    { extension: 'webp', names: ['webp'], mimeType: 'image/webp' },
  ],
} as const satisfies Record<string, readonly LibraryFormat[]>;

export type LibraryKind = keyof typeof MEDIA_FORMATS;

// Target packs (.mind) have no registered type and are uploaded as
// application/octet-stream; a browser also sends that for a .glb whose
// File.type is empty.
export const TARGET_PACK_MIME_TYPE = 'application/octet-stream';

export const AR_MEDIA_ALLOWED_MIME_TYPES: readonly string[] = [
  ...Object.values(MEDIA_FORMATS).flatMap((formats) =>
    formats.map((format) => format.mimeType),
  ),
  TARGET_PACK_MIME_TYPE,
];

// 50 MB: the bucket limit, equal to the largest target pack
// (cms_pack_max_bytes) and to the Free plan's project upload limit.
export const AR_MEDIA_MAX_BYTES = 52428800;

const WRONG_FORMAT: Record<LibraryKind, string> = {
  VIDEO: 'Choose an MP4 or WebM video.',
  MODEL_3D: 'Choose a .glb model file.',
  IMAGE: 'Choose a PNG, JPEG or WebP image.',
};

const nameExtension = (fileName: string) => {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
};

// The format a file is stored as, or the reason it cannot be uploaded. The
// file name decides the format; a reported type must agree with it. An
// empty or generic type is accepted and replaced with the format's type.
export function libraryFormatOf(
  file: { name: string; type: string; size: number },
  kind: LibraryKind,
): { format: LibraryFormat } | { error: string } {
  const extension = nameExtension(file.name);
  const format = (MEDIA_FORMATS[kind] as readonly LibraryFormat[]).find((candidate) =>
    candidate.names.includes(extension),
  );

  if (!format) {
    return { error: WRONG_FORMAT[kind] };
  }

  const reported = file.type.toLowerCase();

  if (reported !== '' && reported !== TARGET_PACK_MIME_TYPE && reported !== format.mimeType) {
    return {
      error: `This file reports the type ${file.type}, which does not match a .${extension} file. ${WRONG_FORMAT[kind]}`,
    };
  }

  if (!(file.size > 0)) {
    return { error: 'The file is empty.' };
  }

  if (file.size > AR_MEDIA_MAX_BYTES) {
    return { error: 'The file is larger than 50 MB.' };
  }

  return { format };
}

// Value for <input type="file" accept>.
export const acceptFor = (kind: LibraryKind) =>
  (MEDIA_FORMATS[kind] as readonly LibraryFormat[])
    .flatMap((format) => [...format.names.map((name) => `.${name}`), format.mimeType])
    .join(',');

// ---------------------------------------------- scanner assets (ar-assets)
// Branding images, the loading animation and the three legacy videos. Same
// formats and size limit as the Media Library, so no SVG, GIF or MOV.
export const SCANNER_ASSET_KINDS = {
  scannerBorder: 'IMAGE',
  scannerTitle: 'IMAGE',
  scannerFrame: 'IMAGE',
  scannerBottom: 'IMAGE',
  loadingAnimation: 'VIDEO',
  animation01: 'VIDEO',
  animation02: 'VIDEO',
  animation03: 'VIDEO',
} as const satisfies Record<keyof ARContentConfig, 'IMAGE' | 'VIDEO'>;

export type ScannerAssetKey = keyof typeof SCANNER_ASSET_KINDS;

export const AR_ASSETS_ALLOWED_MIME_TYPES: readonly string[] = [
  ...MEDIA_FORMATS.IMAGE.map((format) => format.mimeType),
  ...MEDIA_FORMATS.VIDEO.map((format) => format.mimeType),
];

export const AR_ASSETS_MAX_BYTES = AR_MEDIA_MAX_BYTES;

export const scannerAssetFormatOf = (
  key: ScannerAssetKey,
  file: { name: string; type: string; size: number },
) => libraryFormatOf(file, SCANNER_ASSET_KINDS[key]);
