import { supabase } from '../lib/supabase';
import { validateLayerInput, type LayerInput } from './layerRules';
import type { ArtworkLayerWithMedia, Media } from './types';

// The database remains authoritative: it checks each layer again with the
// Phase 2C.1 trigger, including when a media item has changed in another tab.
export async function listArtworkLayers(artworkId: string): Promise<ArtworkLayerWithMedia[]> {
  const { data, error } = await supabase
    .from('artwork_layers')
    .select('*, media:media(*)')
    .eq('artwork_id', artworkId)
    .order('sort_order')
    .order('created_at');

  if (error) {
    throw error;
  }

  return data as unknown as ArtworkLayerWithMedia[];
}

function assertLayer(input: LayerInput, media: Media | null): void {
  const problem = validateLayerInput(input, media);

  if (problem) {
    throw new Error(problem);
  }
}

export async function createArtworkLayer(
  artworkId: string,
  input: LayerInput,
  media: Media | null,
): Promise<void> {
  assertLayer(input, media);

  const { error } = await supabase
    .from('artwork_layers')
    .insert({ ...input, artwork_id: artworkId });

  if (error) {
    throw error;
  }
}

export async function updateArtworkLayer(
  artworkId: string,
  layerId: string,
  input: LayerInput,
  media: Media | null,
): Promise<void> {
  assertLayer(input, media);

  const { data, error } = await supabase
    .from('artwork_layers')
    .update(input)
    .eq('id', layerId)
    .eq('artwork_id', artworkId)
    .select('id')
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error('This layer no longer exists or you cannot edit it. Reload the artwork.');
  }
}

export async function deleteArtworkLayer(
  artworkId: string,
  layerId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('artwork_layers')
    .delete()
    .eq('id', layerId)
    .eq('artwork_id', artworkId)
    .select('id')
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error('This layer no longer exists or you cannot delete it. Reload the artwork.');
  }
}
