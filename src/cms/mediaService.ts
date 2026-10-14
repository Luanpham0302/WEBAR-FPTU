import type { VideoMode } from '../ar/types';
import { supabase } from '../lib/supabase';
import { inspectFile } from './fileInspect';
import {
  ACTIVE_PROVIDER,
  BUCKETS,
  IMMUTABLE_CACHE_CONTROL,
  getStorage,
  type ObjectRef,
} from './storage';
import { extensionOf, mediaKey, triggerKey } from './storageKeys';
import {
  TRIGGER_RULES,
  checkTriggerImage,
  duplicateIssue,
  findDuplicateTrigger,
  hasBlockingIssue,
} from './triggerRules';
import type { LibraryMediaType, Media, MediaStatus, MediaType } from './types';

export const TRIGGER_MIME_TYPES: readonly string[] = TRIGGER_RULES.mimeTypes;

export const mediaRef = (media: Media): ObjectRef => ({
  provider: media.storage_provider,
  bucket: media.bucket,
  key: media.storage_key,
});

export async function listMedia(options: {
  type?: MediaType;
  includeArchived?: boolean;
} = {}): Promise<Media[]> {
  let query = supabase
    .from('media')
    .select('*')
    .order('created_at', { ascending: false });

  if (options.type) {
    query = query.eq('type', options.type);
  }

  if (!options.includeArchived) {
    query = query.eq('status', 'active');
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data as Media[];
}

// Rejects a file the runtime could not use for this media type.
export function checkFileForType(file: File, type: MediaType): string | null {
  const extension = extensionOf(file.name, file.type);

  switch (type) {
    case 'VIDEO':
      return file.type.startsWith('video/')
        ? null
        : 'Choose a video file (MP4 works on every phone).';
    case 'MODEL_3D':
      return extension === 'glb' ? null : 'Choose a .glb model file.';
    case 'IMAGE':
      return file.type.startsWith('image/') ? null : 'Choose an image file.';
    case 'TRIGGER':
      return TRIGGER_MIME_TYPES.includes(file.type)
        ? null
        : 'A trigger image must be a PNG or JPEG file.';
  }
}

const mimeTypeOf = (file: File, type: MediaType) =>
  file.type || (type === 'MODEL_3D' ? 'model/gltf-binary' : 'application/octet-stream');

const inspectKind = (type: MediaType) => {
  if (type === 'VIDEO') {
    return 'video' as const;
  }

  return type === 'MODEL_3D' ? ('other' as const) : ('image' as const);
};

type NewMediaRow = Omit<Media, 'status' | 'created_at' | 'updated_at'>;

// Uploads the bytes, then records the row. If the row cannot be written the
// upload is removed again where the role allows it; otherwise the orphan is
// left for administrative cleanup. An orphan is never visible to visitors.
async function storeAndRecord(row: NewMediaRow, file: File): Promise<Media> {
  const storage = getStorage(row.storage_provider);

  const { alreadyExisted } = await storage.upload(row.bucket, row.storage_key, file, {
    contentType: row.mime_type,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
  });

  const { data, error } = await supabase
    .from('media')
    .insert(row)
    .select()
    .single();

  if (error) {
    if (!alreadyExisted) {
      await storage.delete(row.bucket, row.storage_key).catch(() => undefined);
    }

    throw error;
  }

  return data as Media;
}

export async function uploadLibraryMedia(input: {
  file: File;
  type: LibraryMediaType;
  name: string;
  videoMode: VideoMode;
}): Promise<Media> {
  const { file, type } = input;
  const problem = checkFileForType(file, type);

  if (problem) {
    throw new Error(problem);
  }

  const facts = await inspectFile(file, inspectKind(type));
  const id = crypto.randomUUID();

  return storeAndRecord(
    {
      id,
      name: input.name.trim() || file.name,
      type,
      storage_provider: ACTIVE_PROVIDER,
      bucket: BUCKETS.media,
      storage_key: mediaKey(id, facts.sha256, extensionOf(file.name, file.type)),
      sha256: facts.sha256,
      mime_type: mimeTypeOf(file, type),
      file_size: file.size,
      width: facts.width,
      height: facts.height,
      duration: facts.duration,
      video_mode: type === 'VIDEO' ? input.videoMode : null,
    },
    file,
  );
}

// Stores a trigger source image privately and returns its media row. The
// same file uploaded again for the same artwork reuses the existing row.
export async function uploadTriggerMedia(input: {
  file: File;
  campaignId: string;
  artworkId: string;
  name: string;
}): Promise<Media> {
  const { file } = input;
  const problem = checkFileForType(file, 'TRIGGER');

  if (problem) {
    throw new Error(problem);
  }

  const facts = await inspectFile(file, 'image');

  // Format, resolution and aspect ratio. Errors stop here, before anything
  // is stored; warnings are shown by the editor from the stored facts.
  const issues = checkTriggerImage({
    mimeType: file.type,
    width: facts.width ?? 0,
    height: facts.height ?? 0,
    fileSize: file.size,
  });

  // The same image on another artwork of this campaign. The database also
  // refuses this, which covers two editors uploading at the same moment.
  const { data: siblings, error: siblingsError } = await supabase
    .from('artworks')
    .select('id, name, status, trigger_sha256')
    .eq('campaign_id', input.campaignId)
    .eq('trigger_sha256', facts.sha256);

  if (siblingsError) {
    throw siblingsError;
  }

  const owner = findDuplicateTrigger(facts.sha256, input.artworkId, siblings);

  if (owner) {
    issues.push(duplicateIssue(owner.name));
  }

  if (hasBlockingIssue(issues)) {
    throw new Error(
      issues
        .filter((issue) => issue.level === 'error')
        .map((issue) => issue.message)
        .join(' '),
    );
  }

  const key = triggerKey(
    input.campaignId,
    input.artworkId,
    facts.sha256,
    extensionOf(file.name, file.type),
  );

  const { data: existing, error } = await supabase
    .from('media')
    .select('*')
    .eq('storage_provider', ACTIVE_PROVIDER)
    .eq('bucket', BUCKETS.sources)
    .eq('storage_key', key)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (existing) {
    return existing as Media;
  }

  return storeAndRecord(
    {
      id: crypto.randomUUID(),
      name: input.name.trim() || file.name,
      type: 'TRIGGER',
      storage_provider: ACTIVE_PROVIDER,
      bucket: BUCKETS.sources,
      storage_key: key,
      sha256: facts.sha256,
      mime_type: mimeTypeOf(file, 'TRIGGER'),
      file_size: file.size,
      width: facts.width,
      height: facts.height,
      duration: null,
      video_mode: null,
    },
    file,
  );
}

// Only descriptive fields can change. The file itself is immutable: the
// database rejects any change to it.
export async function updateMedia(
  id: string,
  changes: { name?: string; video_mode?: VideoMode; status?: MediaStatus },
) {
  const { error } = await supabase.from('media').update(changes).eq('id', id);

  if (error) {
    throw error;
  }
}
