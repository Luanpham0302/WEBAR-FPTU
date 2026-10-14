import * as THREE from 'three';
import type {
  Artwork,
  LayerContext,
  LayerRuntime,
  VideoLayerConfig,
} from './types';
import { zoomedScale } from './zoom';

const VIDEO_PRELOAD_TIMEOUT_MS = 8000;

function preloadVideoStart(video: HTMLVideoElement, src: string) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('error', handleError);
    };

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const handleCanPlay = () => finish();
    const handleError = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(`Animation file could not load from ${src}.`));
    };

    const timeoutId = window.setTimeout(finish, VIDEO_PRELOAD_TIMEOUT_MS);

    video.addEventListener('canplay', handleCanPlay, { once: true });
    video.addEventListener('error', handleError, { once: true });

    video.load();

    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      finish();
    }
  });
}

function mapFullVideoToTarget(texture: THREE.VideoTexture) {
  texture.repeat.set(1, 1);
  texture.offset.set(0, 0);
}

// Alpha-packed video: colour in the left half of the frame, alpha in the right.
function createAlphaPackedMaterial(texture: THREE.VideoTexture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      videoMap: { value: texture },
    },
    vertexShader: `
      varying vec2 vVideoUv;

      void main() {
        vVideoUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D videoMap;
      varying vec2 vVideoUv;

      void main() {
        vec2 colorUv = vec2(vVideoUv.x * 0.5, vVideoUv.y);
        vec2 alphaUv = vec2(0.5 + vVideoUv.x * 0.5, vVideoUv.y);
        vec3 color = texture2D(videoMap, colorUv).rgb;
        float alpha = texture2D(videoMap, alphaUv).r;

        if (alpha < 0.01) {
          discard;
        }

        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function createNormalMaterial(texture: THREE.VideoTexture) {
  return new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function releaseVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

export async function createVideoLayer(
  config: VideoLayerConfig,
  artwork: Artwork,
  context: LayerContext,
): Promise<LayerRuntime> {
  const video = document.createElement('video');
  video.src = config.src;
  video.crossOrigin = 'anonymous';
  video.loop = config.loop;
  // Always starts muted so autoplay is allowed; sound is applied on play.
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('webkit-playsinline', 'true');
  video.preload = 'metadata';

  try {
    await preloadVideoStart(video, config.src);
  } catch (error) {
    releaseVideo(video);
    throw error;
  }

  const texture = new THREE.VideoTexture(video);
  texture.encoding = THREE.sRGBEncoding;
  mapFullVideoToTarget(texture);

  const isAlphaPacked = config.videoMode === 'alpha-packed';

  // MindAR normalizes every target to width 1. Its height must follow
  // the dimensions embedded in the .mind file for a 1:1 overlay.
  let aspectRatio = artwork.targetHeight / artwork.targetWidth;

  if (config.fit === 'video' && video.videoWidth > 0 && video.videoHeight > 0) {
    const contentWidth = isAlphaPacked ? video.videoWidth / 2 : video.videoWidth;
    aspectRatio = video.videoHeight / contentWidth;
  }

  const geometry = new THREE.PlaneGeometry(1, aspectRatio);
  const material = isAlphaPacked
    ? createAlphaPackedMaterial(texture)
    : createNormalMaterial(texture);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.setScalar(config.scale);
  mesh.position.set(...config.position);

  const play = () => {
    video.muted = config.muted || !context.isSoundEnabled();

    return video.play().catch(() => {
      if (video.muted) {
        return undefined;
      }

      // Sound needs a user gesture here (typically iOS). Keep the picture
      // running muted; the next tap calls resume() and unlocks the audio.
      video.muted = true;
      context.onSoundBlocked();
      return video.play().catch(() => undefined);
    });
  };

  return {
    object3D: mesh,
    activate() {
      video.currentTime = 0;
      void play();
    },
    resume() {
      const shouldBeMuted = config.muted || !context.isSoundEnabled();

      if (video.paused || video.muted !== shouldBeMuted) {
        void play();
      }
    },
    pause() {
      video.pause();
    },
    update() {},
    // Scales the video plane uniformly around its own centre. Position,
    // rotation and aspect ratio stay as configured.
    setZoom(factor) {
      mesh.scale.setScalar(zoomedScale(config.scale, factor));
    },
    dispose() {
      releaseVideo(video);
      mesh.removeFromParent();
      texture.dispose();
      material.dispose();
      geometry.dispose();
    },
  };
}
