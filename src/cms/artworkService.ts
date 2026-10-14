import { supabase } from '../lib/supabase';
import type { Artwork, ArtworkStatus, ArtworkWithTrigger, Media } from './types';

export type ArtworkInput = {
  name: string;
  description: string;
  category: string;
  status: ArtworkStatus;
  sort_order: number;
};

const WITH_TRIGGER = '*, trigger:media!artworks_trigger_media_id_fkey(*)';

export async function listArtworks(
  campaignId: string,
): Promise<ArtworkWithTrigger[]> {
  const { data, error } = await supabase
    .from('artworks')
    .select(WITH_TRIGGER)
    .eq('campaign_id', campaignId)
    .order('sort_order')
    .order('created_at');

  if (error) {
    throw error;
  }

  return data as unknown as ArtworkWithTrigger[];
}

export async function createArtwork(
  campaignId: string,
  input: ArtworkInput,
): Promise<Artwork> {
  const { data, error } = await supabase
    .from('artworks')
    .insert({ ...input, campaign_id: campaignId })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data as Artwork;
}

export async function updateArtwork(
  id: string,
  input: Partial<ArtworkInput>,
): Promise<Artwork> {
  const { data, error } = await supabase
    .from('artworks')
    .update(input)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data as Artwork;
}

// Points the artwork at a trigger media row and records what was measured
// when it was uploaded. Nothing is compiled here.
export async function setArtworkTrigger(artworkId: string, trigger: Media) {
  if (trigger.type !== 'TRIGGER' || !trigger.width || !trigger.height) {
    throw new Error('That media object is not a trigger image.');
  }

  const { error } = await supabase
    .from('artworks')
    .update({
      trigger_media_id: trigger.id,
      trigger_width: trigger.width,
      trigger_height: trigger.height,
      trigger_sha256: trigger.sha256,
    })
    .eq('id', artworkId);

  if (error) {
    throw error;
  }
}

// Removes the trigger from the artwork. An artwork without a trigger cannot
// be Ready, so it goes back to Draft. The stored image and every target pack
// already compiled from it are untouched.
export async function clearArtworkTrigger(artwork: Artwork) {
  const { error } = await supabase
    .from('artworks')
    .update({
      trigger_media_id: null,
      trigger_width: null,
      trigger_height: null,
      trigger_sha256: null,
      status: artwork.status === 'ready' ? 'draft' : artwork.status,
    })
    .eq('id', artwork.id);

  if (error) {
    throw error;
  }
}

// Copies the artwork and its layers as a new draft at the end of the list.
// The trigger image is NOT copied: two artworks with the same trigger in one
// campaign cannot be told apart by MindAR.
export async function duplicateArtwork(source: Artwork): Promise<Artwork> {
  const { data: last, error: orderError } = await supabase
    .from('artworks')
    .select('sort_order')
    .eq('campaign_id', source.campaign_id)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (orderError) {
    throw orderError;
  }

  const copy = await createArtwork(source.campaign_id, {
    name: `${source.name} (copy)`,
    description: source.description,
    category: source.category,
    status: 'draft',
    sort_order: (last?.sort_order ?? source.sort_order) + 1,
  });

  const { data: layers, error: layersError } = await supabase
    .from('artwork_layers')
    .select('*')
    .eq('artwork_id', source.id);

  if (layersError) {
    throw layersError;
  }

  if (layers.length > 0) {
    const { error } = await supabase.from('artwork_layers').insert(
      layers.map(
        ({
          id: _id,
          created_at: _createdAt,
          updated_at: _updatedAt,
          created_by: _createdBy,
          updated_by: _updatedBy,
          ...layer
        }) => ({ ...layer, artwork_id: copy.id }),
      ),
    );

    if (error) {
      throw error;
    }
  }

  return copy;
}

export function nextSortOrder(artworks: Artwork[]): number {
  return artworks.reduce((max, artwork) => Math.max(max, artwork.sort_order), 0) + 1;
}
