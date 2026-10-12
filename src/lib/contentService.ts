import { supabase } from './supabase';

export type ARContentConfig = {
  scannerBorder: string;
  scannerTitle: string;
  scannerFrame: string;
  scannerBottom: string;

  loadingAnimation: string;

  animation01: string;
  animation02: string;
  animation03: string;
};

export const DEFAULT_AR_CONTENT: ARContentConfig = {
  scannerBorder: '/ui/scanner-border-1080x1920.png',
  scannerTitle: '/ui/scanner-title.png',
  scannerFrame: '/ui/scanner-frame.png',
  scannerBottom: '/ui/scanner-bottom.png',

  loadingAnimation: '/animations/Demo.mp4',

  animation01: '/animations/anim-01-alpha.mp4',
  animation02: '/animations/anim-02-alpha.mp4',
  animation03: '/animations/anim-03-alpha.mp4',
};

export async function getARContent(): Promise<ARContentConfig> {
  const { data, error } = await supabase
    .from('ar_content')
    .select('config')
    .eq('id', 'main')
    .maybeSingle();

  if (error) {
    console.error('Load config error:', error);
    return DEFAULT_AR_CONTENT;
  }

  if (!data?.config) {
    return DEFAULT_AR_CONTENT;
  }

  return {
    ...DEFAULT_AR_CONTENT,
    ...(data.config as Partial<ARContentConfig>),
  };
}

export async function saveARContent(
  config: ARContentConfig,
) {
  const { error } = await supabase
    .from('ar_content')
    .upsert({
      id: 'main',
      config,
      updated_at: new Date().toISOString(),
    });

  if (error) {
    throw error;
  }
}

export async function uploadARAsset(
  key: keyof ARContentConfig,
  file: File,
) {
  const extension =
    file.name.split('.').pop()?.toLowerCase() || 'bin';

  const path = `live/${key}.${extension}`;

  const { error } = await supabase.storage
    .from('ar-assets')
    .upload(path, file, {
      upsert: true,
      contentType: file.type || undefined,
      cacheControl: '60',
    });

  if (error) {
    throw error;
  }

  const { data } = supabase.storage
    .from('ar-assets')
    .getPublicUrl(path);

  return `${data.publicUrl}?v=${Date.now()}`;
}