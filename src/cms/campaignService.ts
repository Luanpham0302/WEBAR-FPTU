import { supabase } from '../lib/supabase';
import type { Campaign, CampaignStatus } from './types';

export type CampaignInput = {
  name: string;
  slug: string;
  description: string;
};

export async function listCampaigns(): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .order('status')
    .order('name');

  if (error) {
    throw error;
  }

  return data as Campaign[];
}

export async function createCampaign(input: CampaignInput): Promise<Campaign> {
  const { data, error } = await supabase
    .from('campaigns')
    .insert(input)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data as Campaign;
}

export async function updateCampaign(
  id: string,
  input: CampaignInput,
): Promise<Campaign> {
  const { data, error } = await supabase
    .from('campaigns')
    .update(input)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data as Campaign;
}

// Archiving is the only way a campaign leaves the list. It is never
// hard-deleted here, so old releases keep their campaign.
export async function setCampaignStatus(id: string, status: CampaignStatus) {
  const { error } = await supabase
    .from('campaigns')
    .update({ status })
    .eq('id', id);

  if (error) {
    throw error;
  }
}

export type CmsCounts = {
  campaigns: number;
  artworks: number;
  media: number;
};

export async function loadCounts(): Promise<CmsCounts> {
  const count = async (table: string) => {
    const { count: total, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
      .neq('status', 'archived');

    if (error) {
      throw error;
    }

    return total ?? 0;
  };

  const [campaigns, artworks, media] = await Promise.all([
    count('campaigns'),
    count('artworks'),
    count('media'),
  ]);

  return { campaigns, artworks, media };
}
