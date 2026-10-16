import { supabase } from '../lib/supabase';
import type { ReleaseManifest } from './manifest';

export type CmsRelease = {
  id: string;
  campaign_id: string;
  version: number;
  target_pack_id: string;
  preview_token: string;
  status: 'preview' | 'published' | 'superseded';
  notes: string;
  created_at: string;
  published_at: string | null;
};

export async function listReleases(campaignId: string): Promise<CmsRelease[]> {
  const { data, error } = await supabase.from('releases')
    .select('id,campaign_id,version,target_pack_id,preview_token,status,notes,created_at,published_at')
    .eq('campaign_id', campaignId)
    .order('version', { ascending: false });
  if (error) throw error;
  return data as CmsRelease[];
}

export async function verifyTargetPackTrusted(packId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('cms-verify-pack', {
    body: { packId },
  });
  if (error) {
    // Function may not yet be deployed, or JWT may be expired.
    throw new Error('Trusted pack verification failed: ' + error.message);
  }
  if (data?.verified !== true) {
    throw new Error(data?.message ?? 'The trusted backend did not verify this pack.');
  }
}

export async function createRelease(packId: string, notes: string): Promise<CmsRelease> {
  const { data, error } = await supabase.rpc('cms_create_release', {
    p_pack_id: packId,
    p_notes: notes,
  });
  if (error) throw error;
  return data as CmsRelease;
}

export async function publishRelease(releaseId: string): Promise<void> {
  const { error } = await supabase.rpc('cms_publish_release', {
    p_release_id: releaseId,
  });
  if (error) throw error;
}

export async function getLiveManifest(): Promise<ReleaseManifest | null> {
  const { data, error } = await supabase.rpc('cms_get_live_manifest');
  if (error) throw error;
  return data as ReleaseManifest | null;
}

export async function getPrivatePreviewManifest(token: string): Promise<ReleaseManifest> {
  const { data, error } = await supabase.rpc('cms_get_preview_manifest', {
    p_token: token,
  });
  if (error) throw error;
  if (!data) throw new Error('Preview not found. Sign in as a CMS member and check the URL.');
  return data as ReleaseManifest;
}
