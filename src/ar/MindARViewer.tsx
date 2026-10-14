import {
  DEFAULT_AR_CONTENT,
  loadARContent,
  type ARContentConfig,
} from '../lib/contentService';
import { useEffect, useRef, useState } from 'react';
import { Clock, DirectionalLight, HemisphereLight } from 'three';
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
import { arTargetConfig } from '../config/arTargets';
import {
  MAX_PAUSED_ARTWORKS,
  SHOW_ZOOM_CONTROLS,
  applyRemoteVideoOverrides,
  selectProfile,
} from '../config/arProfiles';
import { ArtworkManager, type ActiveArtworkPhase } from './artworkManager';
import { rotateMatchOrder } from './rotateMatchOrder';
import type { Artwork } from './types';
import { ZOOM_MAX, ZOOM_MIN, touchDistance, zoomPercent } from './zoom';

// Zoom applies to video layers; an artwork with none shows no zoom controls.
const hasVideoLayer = (artwork: Artwork) =>
  artwork.layers.some((layer) => layer.type === 'VIDEO');

const fingerDistance = (a: Touch, b: Touch) =>
  touchDistance({ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY });

// A touch on a button (sound, zoom, retry) is a tap on that button, never
// the start of a pinch.
const isOnControl = (touch: Touch) =>
  touch.target instanceof Element && touch.target.closest('button') !== null;

const LAYER_HINT_TEXT: Record<ActiveArtworkPhase, string | null> = {
  loading: 'LOADING...',
  playing: null,
  partial: 'SOME CONTENT UNAVAILABLE',
  error: 'CONTENT UNAVAILABLE',
};

type ARStatus = 'starting' | 'scanning' | 'found' | 'lost' | 'error';

// 'loading': the published content config has not arrived yet.
// 'error': it could not be read; built-in defaults are in use.
type ConfigStatus = 'loading' | 'ready' | 'error';

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
  const shellRef = useRef<HTMLDivElement | null>(null);
  const loadingVideoRef = useRef<HTMLVideoElement | null>(null);
  const artworkManagerRef = useRef<ArtworkManager | null>(null);
  // Zoom of the tracked artwork in percent; null when there is nothing to
  // zoom (no target tracked, or the tracked artwork has no video).
  const [zoomUi, setZoomUi] = useState<number | null>(null);
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
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('loading');
  const [loadingVideoFailed, setLoadingVideoFailed] = useState(false);

  // The loading video is the published one, so it is only known once the
  // config has arrived. Until then, and if the config or the video fails,
  // the splash shows no video at all rather than a built-in one.
  const loadingVideoSrc =
    isLoading && configStatus === 'ready' && !loadingVideoFailed
      ? contentConfig.loadingAnimation || null
      : null;

  useEffect(() => {
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

      // The splash is going away: stop the video and free its decoder.
      loadingVideo.pause();
      loadingVideo.removeAttribute('src');
      loadingVideo.load();
    };
  }, [loadingVideoSrc]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    let isMounted = true;
    let mindarThree: MindARThree | null = null;
    // Whether the tracked artwork has a video that a pinch can zoom.
    let canZoom = false;

    const artworkManager = new ArtworkManager({
      maxPaused: MAX_PAUSED_ARTWORKS,
      onActiveChange: (info) => {
        if (!isMounted) {
          return;
        }

        setLayerHint(info?.phase ?? null);
        setStatus(info ? 'found' : 'lost');

        canZoom = info !== null && hasVideoLayer(info.artwork);
        const factor = artworkManager.zoom.current();
        setZoomUi(canZoom && factor !== null ? zoomPercent(factor) : null);
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

    // ---- Pinch-to-zoom of the tracked artwork's video.
    // Two fingers on the camera view scale the video; the page itself must
    // never zoom or scroll. CSS touch-action: none covers Android Chrome;
    // iOS Safari also needs touchmove and its own gesture events cancelled.
    const shell = shellRef.current;
    let zoomFrame = 0;

    // At most one React update per frame while the fingers move.
    const showZoom = () => {
      if (zoomFrame) {
        return;
      }

      zoomFrame = window.requestAnimationFrame(() => {
        zoomFrame = 0;
        const factor = artworkManager.zoom.current();

        if (isMounted && canZoom && factor !== null) {
          setZoomUi(zoomPercent(factor));
        }
      });
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        // A third finger, or back to one: stop zooming.
        artworkManager.zoom.pinchEnd();
        return;
      }

      const [a, b] = [event.touches[0], event.touches[1]];

      if (canZoom && !isOnControl(a) && !isOnControl(b)) {
        artworkManager.zoom.pinchStart(fingerDistance(a, b));
      }
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        return;
      }

      // Never let two fingers zoom or scroll the page in the scanner.
      event.preventDefault();

      if (artworkManager.zoom.pinching) {
        artworkManager.zoom.pinchMove(
          fingerDistance(event.touches[0], event.touches[1]),
        );
        showZoom();
      }
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        artworkManager.zoom.pinchEnd();
      }
    };

    const preventPageGesture = (event: Event) => event.preventDefault();

    shell?.addEventListener('touchstart', handleTouchStart, { passive: true });
    shell?.addEventListener('touchmove', handleTouchMove, { passive: false });
    shell?.addEventListener('touchend', handleTouchEnd, { passive: true });
    shell?.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    // Safari-only pinch events; cancelling them stops page zoom on iOS.
    document.addEventListener('gesturestart', preventPageGesture, { passive: false });
    document.addEventListener('gesturechange', preventPageGesture, { passive: false });
    document.addEventListener('gestureend', preventPageGesture, { passive: false });

    const startAR = async () => {
      try {
        setIsLoading(true);
        setStartupError(null);
        setStatus('starting');

        const { config: remoteContent, status: remoteStatus } =
          await loadARContent();

        if (!isMounted) {
          return;
        }

        setContentConfig(remoteContent);
        setConfigStatus(remoteStatus);

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
      shell?.removeEventListener('touchstart', handleTouchStart);
      shell?.removeEventListener('touchmove', handleTouchMove);
      shell?.removeEventListener('touchend', handleTouchEnd);
      shell?.removeEventListener('touchcancel', handleTouchEnd);
      document.removeEventListener('gesturestart', preventPageGesture);
      document.removeEventListener('gesturechange', preventPageGesture);
      document.removeEventListener('gestureend', preventPageGesture);
      window.cancelAnimationFrame(zoomFrame);
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

  // The + / - / RESET buttons. Same zoom state as the pinch.
  const changeZoom = (action: 'in' | 'out' | 'reset') => {
    const zoom = artworkManagerRef.current?.zoom;

    if (!zoom) {
      return;
    }

    const factor =
      action === 'reset' ? zoom.reset() : zoom.step(action === 'in' ? 1 : -1);

    if (factor !== null) {
      setZoomUi(zoomPercent(factor));
    }
  };

  const showZoomControls =
    SHOW_ZOOM_CONTROLS && zoomUi !== null && !isLoading && !startupError;

  let soundLabel = 'SOUND OFF';

  if (soundOn) {
    soundLabel = soundBlocked ? 'TAP FOR SOUND' : 'SOUND ON';
  }

  return (
    <div ref={shellRef} className="ar-shell">
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
          {loadingVideoSrc && (
            <video
              key={loadingVideoSrc}
              ref={loadingVideoRef}
              className="boot-splash__animation"
              src={loadingVideoSrc}
              autoPlay
              controls={false}
              loop
              muted
              playsInline
              preload="auto"
              onError={() => setLoadingVideoFailed(true)}
            />
          )}
          {/* Text only when there is no video to show; the video carries
              its own. Nothing while the config is still on its way. */}
          {!loadingVideoSrc && configStatus !== 'loading' && (
            <p className="boot-splash__title">LOADING...</p>
          )}
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

      {showZoomControls && (
        <div className="ar-zoom-controls" role="group" aria-label="Video zoom">
          <button
            className="ar-zoom-controls__button"
            type="button"
            aria-label="Zoom out"
            disabled={zoomUi <= Math.round(ZOOM_MIN * 100)}
            onClick={() => changeZoom('out')}
          >
            -
          </button>
          <span className="ar-zoom-controls__value" aria-live="polite">
            {zoomUi}%
          </span>
          <button
            className="ar-zoom-controls__button"
            type="button"
            aria-label="Zoom in"
            disabled={zoomUi >= Math.round(ZOOM_MAX * 100)}
            onClick={() => changeZoom('in')}
          >
            +
          </button>
          <button
            className="ar-zoom-controls__button ar-zoom-controls__reset"
            type="button"
            aria-label="Reset zoom"
            disabled={zoomUi === 100}
            onClick={() => changeZoom('reset')}
          >
            RESET
          </button>
        </div>
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
