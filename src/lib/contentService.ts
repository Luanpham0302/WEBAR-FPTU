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

  // Empty = no loading video; the splash shows its text fallback instead.
  loadingAnimation: '',

  animation01: '/animations/anim-01-alpha.mp4',
  animation02: '/animations/anim-02-alpha.mp4',
  animation03: '/animations/anim-03-alpha.mp4',
};

// The retired built-in loading video. A config published while it was the
// default may still name it; that counts as no loading animation.
const RETIRED_LOADING_ANIMATION = '/animations/Demo.mp4';

// 'error': the published config could not be read and `config` holds the
// built-in defaults.
export type ARContentResult = {
  config: ARContentConfig;
  status: 'ready' | 'error';
};

export async function loadARContent(): Promise<ARContentResult> {
  const { data, error } = await supabase
    .from('ar_content')
    .select('config')
    .eq('id', 'main')
    .maybeSingle();

  if (error) {
    console.error('Load config error:', error);
    return { config: DEFAULT_AR_CONTENT, status: 'error' };
  }

  if (!data?.config) {
    return { config: DEFAULT_AR_CONTENT, status: 'ready' };
  }

  const config: ARContentConfig = {
    ...DEFAULT_AR_CONTENT,
    ...(data.config as Partial<ARContentConfig>),
  };

  if (config.loadingAnimation === RETIRED_LOADING_ANIMATION) {
    config.loadingAnimation = DEFAULT_AR_CONTENT.loadingAnimation;
  }

  return { config, status: 'ready' };
}

export async function getARContent(): Promise<ARContentConfig> {
  return (await loadARContent()).config;
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