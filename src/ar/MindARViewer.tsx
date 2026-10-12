import {
  DEFAULT_AR_CONTENT,
  getARContent,
  type ARContentConfig,
} from '../lib/contentService';
import { useEffect, useRef, useState } from 'react';
import { Clock, DirectionalLight, HemisphereLight } from 'three';
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
import { arTargetConfig } from '../config/arTargets';
import {
  MAX_PAUSED_ARTWORKS,
  applyRemoteVideoOverrides,
  selectProfile,
} from '../config/arProfiles';
import { ArtworkManager, type ActiveArtworkPhase } from './artworkManager';
import { rotateMatchOrder } from './rotateMatchOrder';

const LAYER_HINT_TEXT: Record<ActiveArtworkPhase, string | null> = {
  loading: 'LOADING...',
  playing: null,
  partial: 'SOME CONTENT UNAVAILABLE',
  error: 'CONTENT UNAVAILABLE',
};

type ARStatus = 'starting' | 'scanning' | 'found' | 'lost' | 'error';

type ARStartupError = {
  title: string;
  message: string;
};

class ARAssetError extends Error {}

function describeStartupError(error: unknown): ARStartupError {
  if (error instanceof ARAssetError) {
    return {
      title: 'CONTENT UNAVAILABLE',
      message:
        'Some AR content could not be loaded. Check your connection and try again.',
    };
  }

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return {
      title: 'CAMERA NOT SUPPORTED',
      message:
        'This browser cannot open the camera here. Open the link in Safari (iPhone) or Chrome (Android) over HTTPS.',
    };
  }

  // MindAR rejects without an error when getUserMedia fails, so a failure
  // without details is a camera failure (denied, missing, or in use).
  if (error === undefined) {
    return {
      title: 'CAMERA BLOCKED',
      message:
        'Allow camera access for this site in your browser settings, close other apps using the camera, then try again.',
    };
  }

  return {
    title: 'AR COULD NOT START',
    message: 'Something went wrong while starting the scanner. Please try again.',
  };
}

async function assertAssetExists(src: string, label: string) {
  let response: Response;

  try {
    response = await fetch(src, { method: 'HEAD' });
  } catch {
    throw new ARAssetError(`${label} could not be reached at ${src}.`);
  }

  if (!response.ok) {
    throw new ARAssetError(`${label} was not found at ${src}.`);
  }
}

export default function MindARViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const loadingVideoRef = useRef<HTMLVideoElement | null>(null);
  const artworkManagerRef = useRef<ArtworkManager | null>(null);
  const [profile] = useState(() => selectProfile(window.location.search));
  const [soundOn, setSoundOn] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [status, setStatus] = useState<ARStatus>('starting');
  const [isLoading, setIsLoading] = useState(true);
  const [startupError, setStartupError] = useState<ARStartupError | null>(
    null,
  );
  const [contentConfig, setContentConfig] =
    useState<ARContentConfig>(DEFAULT_AR_CONTENT);
  const [layerHint, setLayerHint] = useState<ActiveArtworkPhase | null>(null);

  useEffect(() => {
    if (!isLoading) {
      return;
    }

    const loadingVideo = loadingVideoRef.current;

    if (!loadingVideo) {
      return;
    }

    const playLoadingVideo = () => {
      loadingVideo.controls = false;
      loadingVideo.muted = true;
      loadingVideo.defaultMuted = true;
      loadingVideo.playsInline = true;
      loadingVideo.setAttribute('playsinline', 'true');
      loadingVideo.setAttribute('webkit-playsinline', 'true');

      if (loadingVideo.paused) {
        void loadingVideo.play().catch(() => undefined);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        playLoadingVideo();
      }
    };

    playLoadingVideo();
    loadingVideo.addEventListener('loadeddata', playLoadingVideo);
    loadingVideo.addEventListener('canplay', playLoadingVideo);
    window.addEventListener('pointerdown', playLoadingVideo, { passive: true });
    window.addEventListener('touchstart', playLoadingVideo, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      loadingVideo.removeEventListener('loadeddata', playLoadingVideo);
      loadingVideo.removeEventListener('canplay', playLoadingVideo);
      window.removeEventListener('pointerdown', playLoadingVideo);
      window.removeEventListener('touchstart', playLoadingVideo);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isLoading]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    let isMounted = true;
    let mindarThree: MindARThree | null = null;

    const artworkManager = new ArtworkManager({
      maxPaused: MAX_PAUSED_ARTWORKS,
      onActiveChange: (info) => {
        if (!isMounted) {
          return;
        }

        setLayerHint(info?.phase ?? null);
        setStatus(info ? 'found' : 'lost');
      },
      onSoundBlocked: () => {
        if (isMounted) {
          setSoundBlocked(true);
        }
      },
    });
    artworkManagerRef.current = artworkManager;

    // Any tap resumes stalled playback. A finished tap (pointerup/touchend)
    // also counts as the user gesture browsers require before playing sound.
    const resumeActiveVideo = () => artworkManager.resumeActive();
    const unlockSound = () => {
      artworkManager.resumeActive();
      setSoundBlocked(false);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        resumeActiveVideo();
      }
    };

    window.addEventListener('pointerdown', resumeActiveVideo, { passive: true });
    window.addEventListener('pointerup', unlockSound, { passive: true });
    window.addEventListener('touchend', unlockSound, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const startAR = async () => {
      try {
        setIsLoading(true);
        setStartupError(null);
        setStatus('starting');

        const remoteContent = await getARContent();

        if (!isMounted) {
          return;
        }

        setContentConfig(remoteContent);

        // Only the legacy videos are managed through the published ar_content.
        const activeProfile =
          profile.id === 'legacy'
            ? applyRemoteVideoOverrides(profile, remoteContent)
            : profile;

        // Only the target file is session-critical. Media is checked when its
        // artwork loads, so one broken file cannot stop the scanner.
        await assertAssetExists(activeProfile.targetSrc, '.mind target file');

        if (!isMounted || !containerRef.current) {
          return;
        }

        mindarThree = new MindARThree({
          container: containerRef.current,
          imageTargetSrc: activeProfile.targetSrc,
          maxTrack: 1,
          uiLoading: 'no',
          uiScanning: '#custom-scanning-frame',
          uiError: 'no',
          filterMinCF: arTargetConfig.tracking.filterMinCF,
          filterBeta: arTargetConfig.tracking.filterBeta,
          warmupTolerance: arTargetConfig.tracking.warmupTolerance,
          missTolerance: arTargetConfig.tracking.missTolerance,
        });

        const { renderer, scene, camera } = mindarThree;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

        const hasModelLayer = activeProfile.artworks.some((artwork) =>
          artwork.layers.some((layer) => layer.type === 'MODEL_3D'),
        );

        if (hasModelLayer) {
          const keyLight = new DirectionalLight(0xffffff, 1);
          keyLight.position.set(0.3, 1, 1);
          scene.add(new HemisphereLight(0xffffff, 0x444444, 1), keyLight);
        }

        activeProfile.artworks.forEach((artwork) => {
          const anchor = mindarThree!.addAnchor(artwork.targetIndex);

          artworkManager.register(artwork, anchor.group);
          anchor.onTargetFound = () =>
            artworkManager.handleTargetFound(artwork.targetIndex);
          anchor.onTargetLost = () =>
            artworkManager.handleTargetLost(artwork.targetIndex);
        });

        await mindarThree.start();

        if (!isMounted) {
          return;
        }

        if (activeProfile.rotateMatchOrder) {
          rotateMatchOrder(mindarThree.controller);
        }

        setIsLoading(false);
        setStatus((currentStatus) =>
          currentStatus === 'starting' ? 'scanning' : currentStatus,
        );
        const clock = new Clock();
        renderer.setAnimationLoop(() => {
          artworkManager.update(clock.getDelta());
          renderer.render(scene, camera);
        });
      } catch (error) {
        if (!isMounted) {
          return;
        }

        console.error('AR startup failed', error);
        setStartupError(describeStartupError(error));
        setStatus('error');
        setIsLoading(false);
      }
    };

    void startAR();

    return () => {
      isMounted = false;
      window.removeEventListener('pointerdown', resumeActiveVideo);
      window.removeEventListener('pointerup', unlockSound);
      window.removeEventListener('touchend', unlockSound);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      artworkManagerRef.current = null;

      if (mindarThree) {
        mindarThree.renderer.setAnimationLoop(null);
        mindarThree.stop();
        mindarThree.renderer.dispose();
      }

      artworkManager.dispose();
    };
  }, [profile]);

  const showBootSplash = isLoading;
  const layerHintText = layerHint ? LAYER_HINT_TEXT[layerHint] : null;
  const hasSound = profile.artworks.some((artwork) =>
    artwork.layers.some((layer) => layer.type === 'VIDEO' && !layer.muted),
  );

  const toggleSound = () => {
    const nextSoundOn = !soundOn;

    // Runs inside the tap, which is what lets the browser start the audio.
    artworkManagerRef.current?.setSoundEnabled(nextSoundOn);
    setSoundOn(nextSoundOn);
    setSoundBlocked(false);
  };

  let soundLabel = 'SOUND OFF';

  if (soundOn) {
    soundLabel = soundBlocked ? 'TAP FOR SOUND' : 'SOUND ON';
  }

  return (
    <div className="ar-shell">
      <div
        id="custom-scanning-overlay"
        className="scanner-overlay"
        aria-hidden="true"
      >
        <img
          className="scanner-border"
          src={contentConfig.scannerBorder}
          alt=""
        />
        <div className="scanner-top">
          <img
            className="scanner-title"
            src={contentConfig.scannerTitle}
            alt="AR Scanner"
          />
        </div>
        <img
          id="custom-scanning-frame"
          className="scanner-frame hidden"
          src={contentConfig.scannerFrame}
          alt=""
        />
        <img
  className="scanner-bottom"
  src={contentConfig.scannerBottom}
  alt=""
/>
      </div>

      <div ref={containerRef} className="ar-container" />

      {showBootSplash && (
        <div className="boot-splash" aria-hidden="true">
          <div className="boot-splash__window">
            <div className="boot-splash__header">
              <span>AR SHIRT</span>
              <span className="boot-splash__close">X</span>
            </div>
            <div className="boot-splash__body">
              <video
                ref={loadingVideoRef}
                className="boot-splash__animation"
                src={contentConfig.loadingAnimation}
                autoPlay
                controls={false}
                loop
                muted
                playsInline
                preload="auto"
              />
              <p className="boot-splash__title">LOADING...</p>
              <div className="boot-splash__hearts" aria-hidden="true">
                <span className="boot-splash__heart">♥</span>
                <span className="boot-splash__heart">♥</span>
                <span className="boot-splash__heart">♥</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {layerHintText && !startupError && (
        <div
          className={`ar-layer-hint ar-layer-hint--${layerHint}`}
          role="status"
        >
          {layerHintText}
        </div>
      )}

      {hasSound && !isLoading && !startupError && (
        <button
          className={`ar-sound-toggle${soundOn ? ' ar-sound-toggle--on' : ''}`}
          type="button"
          aria-pressed={soundOn}
          onClick={toggleSound}
        >
          {soundLabel}
        </button>
      )}

      {startupError && (
        <div className="ar-error" role="alert">
          <div className="ar-error__window">
            <p className="ar-error__title">{startupError.title}</p>
            <p className="ar-error__message">{startupError.message}</p>
            <button
              className="ar-error__retry"
              type="button"
              onClick={() => window.location.reload()}
            >
              TRY AGAIN
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
