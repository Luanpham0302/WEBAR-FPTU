import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ObjectInfo,
  StorageAdapter,
  UploadOptions,
  UploadResult,
} from './StorageAdapter';

type StorageFailure = {
  message?: string;
  status?: number;
  statusCode?: string | number;
};

const isDuplicate = (error: StorageFailure) =>
  error.status === 409 ||
  String(error.statusCode) === '409' ||
  /already exists|duplicate/i.test(error.message ?? '');

const isNotFound = (error: StorageFailure) =>
  error.status === 404 ||
  String(error.statusCode) === '404' ||
  /not.?found/i.test(error.message ?? '');

export class SupabaseStorageAdapter implements StorageAdapter {
  readonly provider = 'supabase';
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async upload(
    bucket: string,
    key: string,
    body: Blob,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    const { error } = await this.client.storage.from(bucket).upload(key, body, {
      // Never replace stored bytes.
      upsert: false,
      contentType: options.contentType || undefined,
      cacheControl: options.cacheControl,
    });

    const ref = { provider: this.provider, bucket, key };

    if (!error) {
      return { ref, alreadyExisted: false };
    }

    if (isDuplicate(error as StorageFailure)) {
      return { ref, alreadyExisted: true };
    }

    throw error;
  }

  async delete(bucket: string, key: string): Promise<void> {
    const { error } = await this.client.storage.from(bucket).remove([key]);

    if (error) {
      throw error;
    }
  }

  getPublicUrl(bucket: string, key: string): string {
    return this.client.storage.from(bucket).getPublicUrl(key).data.publicUrl;
  }

  async getSignedUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(key, expiresInSeconds);

    if (error) {
      throw error;
    }

    return data.signedUrl;
  }

  async head(bucket: string, key: string): Promise<ObjectInfo | null> {
    const { data, error } = await this.client.storage.from(bucket).info(key);

    if (error) {
      if (isNotFound(error as StorageFailure)) {
        return null;
      }

      throw error;
    }

    const info = data as { size?: number; contentType?: string } | null;

    return {
      size: info?.size ?? null,
      contentType: info?.contentType ?? null,
    };
  }
}
