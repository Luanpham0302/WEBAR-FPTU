import { arAssets } from '../ar/arAssets';
import type { ARProfile, Artwork, VideoLayerConfig } from '../ar/types';
import type { ARContentConfig } from '../lib/contentService';
import { arTargetConfig } from './arTargets';

// Loaded artworks kept in memory besides the current one. Set to 0 if device
// testing shows memory pressure.
export const MAX_PAUSED_ARTWORKS = 1;

export const legacyProfile: ARProfile = {
  id: 'legacy',
  targetSrc: arTargetConfig.targetSrc,
  rotateMatchOrder: false,
  artworks: arAssets.map((asset) => ({
    id: `legacy-${asset.targetIndex}`,
    name: asset.name,
    targetIndex: asset.targetIndex,
    targetWidth: asset.targetWidth,
    targetHeight: asset.targetHeight,
    layers: [
      {
        type: 'VIDEO',
        src: asset.videoSrc,
        videoMode: 'alpha-packed',
        fit: 'target',
        scale: asset.overlayScale,
        position: [asset.overlayOffsetX ?? 0, asset.overlayOffsetY ?? 0, 0.01],
        loop: true,
        muted: true,
      },
    ],
  })),
};

// Technical PoC: five triggers in one camera session. Selected with
// ?profile=poc. Video 04, Video 05 and the GLB are development placeholders;
// replace the files (or these paths) with real assets.
const POC_TRIGGER_SIZE = 1254;

const pocArtwork = (
  targetIndex: number,
  name: string,
  layers: Artwork['layers'],
): Artwork => ({
  id: `poc-${targetIndex}`,
  name,
  targetIndex,
  targetWidth: POC_TRIGGER_SIZE,
  targetHeight: POC_TRIGGER_SIZE,
  layers,
});

const pocVideo = (
  src: string,
  videoMode: VideoLayerConfig['videoMode'],
): VideoLayerConfig => ({
  type: 'VIDEO',
  src,
  videoMode,
  fit: 'video',
  scale: 1,
  position: [0, 0, 0.01],
  loop: true,
  // The alpha-packed videos have no soundtrack to turn on.
  muted: videoMode === 'alpha-packed',
});

export const pocProfile: ARProfile = {
  id: 'poc',
  targetSrc: '/targets/targets-poc.mind',
  rotateMatchOrder: true,
  artworks: [
    pocArtwork(0, 'Artwork A', [
      pocVideo('/animations/anim-01-alpha.mp4', 'alpha-packed'),
    ]),
    pocArtwork(1, 'Artwork B', [
      pocVideo('/animations/anim-02-alpha.mp4', 'alpha-packed'),
    ]),
    pocArtwork(2, 'Artwork C', [
      pocVideo('/animations/anim-03-alpha.mp4', 'alpha-packed'),
    ]),
    pocArtwork(3, 'Artwork D', [
      pocVideo('/poc/media/video-04-placeholder.mp4', 'normal'),
    ]),
    pocArtwork(4, 'Artwork E', [
      pocVideo('/poc/media/video-05-placeholder.mp4', 'normal'),
      {
        type: 'MODEL_3D',
        src: '/poc/media/model-placeholder.glb',
        scale: 0.25,
        position: [0, -0.22, 0.2],
        rotation: [90, 0, 0],
      },
    ]),
  ],
};

// The default stays legacy; the PoC only runs when the URL asks for it.
export function selectProfile(search: string): ARProfile {
  return new URLSearchParams(search).get('profile') === 'poc'
    ? pocProfile
    : legacyProfile;
}

// The published ar_content row still replaces the three legacy videos,
// matched by position.
export function applyRemoteVideoOverrides(
  profile: ARProfile,
  content: ARContentConfig,
): ARProfile {
  const videoSources = [
    content.animation01,
    content.animation02,
    content.animation03,
  ];

  return {
    ...profile,
    artworks: profile.artworks.map((artwork, index) => {
      const videoSrc = videoSources[index];

      if (!videoSrc) {
        return artwork;
      }

      let replaced = false;

      return {
        ...artwork,
        layers: artwork.layers.map((layer) => {
          if (replaced || layer.type !== 'VIDEO') {
            return layer;
          }

          replaced = true;
          return { ...layer, src: videoSrc };
        }),
      };
    }),
  };
}
