import type { Object3D } from 'three';

// alpha-packed: colour in the left half of the frame, alpha in the right.
export type VideoMode = 'alpha-packed' | 'normal';

// Anchor space for every layer: 1 unit equals the trigger image width, x/y lie
// in the image plane and +z points out of the image toward the viewer.
export type VideoLayerConfig = {
  type: 'VIDEO';
  src: string;
  videoMode: VideoMode;
  // 'target' stretches the video over the trigger image's shape.
  // 'video' keeps the video's own aspect ratio at the trigger's width.
  fit: 'target' | 'video';
  scale: number;
  position: [number, number, number];
  loop: boolean;
  // true keeps the video silent even when the user turns sound on.
  muted: boolean;
};

export type ModelLayerConfig = {
  type: 'MODEL_3D';
  // GLB file.
  src: string;
  // Size of the model's largest dimension, in trigger widths.
  scale: number;
  position: [number, number, number];
  // Degrees. GLB models are Y-up, so [90, 0, 0] stands them up on the image.
  rotation: [number, number, number];
};

export type LayerConfig = VideoLayerConfig | ModelLayerConfig;

export type Artwork = {
  id: string;
  name: string;
  targetIndex: number;
  // Pixel size of the trigger image as compiled into the .mind file.
  targetWidth: number;
  targetHeight: number;
  layers: LayerConfig[];
};

export type ARProfile = {
  id: string;
  targetSrc: string;
  // Try targets in a different order every frame. See rotateMatchOrder().
  rotateMatchOrder: boolean;
  artworks: Artwork[];
};

export type LayerContext = {
  isSoundEnabled(): boolean;
  // The browser refused to play with sound; the layer fell back to muted.
  onSoundBlocked(): void;
};

export type LayerRuntime = {
  object3D: Object3D;
  // Start from the beginning.
  activate(): void;
  // Continue if playback was interrupted (tab hidden, autoplay blocked), and
  // apply the current sound setting. Call from a user gesture to unlock audio.
  resume(): void;
  pause(): void;
  update(deltaSeconds: number): void;
  dispose(): void;
};

export type ArtworkState =
  | 'UNLOADED'
  | 'LOADING'
  | 'READY'
  | 'ACTIVE'
  | 'PAUSED'
  | 'DISPOSED';
