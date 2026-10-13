// The only contract the CMS has with file storage. Supabase Storage is one
// implementation; a company object store can be another. Nothing outside
// src/cms/storage/ may call a storage SDK directly.

// Where a file lives. This triple is what the database and release manifests
// store, never a URL.
export type ObjectRef = {
  provider: string;
  bucket: string;
  key: string;
};

export type ObjectInfo = {
  size: number | null;
  contentType: string | null;
};

export type UploadOptions = {
  contentType?: string;
  // Seconds a browser or CDN may cache the object.
  cacheControl?: string;
};

export type UploadResult = {
  ref: ObjectRef;
  // The key was already taken. Keys contain the content hash, so this means
  // the same bytes are already stored and the upload counts as done.
  alreadyExisted: boolean;
};

export interface StorageAdapter {
  // Written to the storage_provider column and to manifests.
  readonly provider: string;

  // Never overwrites: an existing key is reported, not replaced.
  upload(
    bucket: string,
    key: string,
    body: Blob,
    options?: UploadOptions,
  ): Promise<UploadResult>;

  delete(bucket: string, key: string): Promise<void>;

  // URL for objects in a public bucket. Does no network request.
  getPublicUrl(bucket: string, key: string): string;

  // Short-lived URL for objects in a private bucket. A company adapter will
  // ask its own backend for this.
  getSignedUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string>;

  // null when the object does not exist.
  head(bucket: string, key: string): Promise<ObjectInfo | null>;
}
