import { useEffect, useRef, useState } from 'react';
import {
  BufferGeometry,
  Clock,
  DirectionalLight,
  HemisphereLight,
  LineBasicMaterial,
  LineLoop,
  Vector3,
} from 'three';
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
import { ArtworkManager } from '../../ar/artworkManager';
import { rotateMatchOrder } from '../../ar/rotateMatchOrder';
import type { ARProfile } from '../../ar/types';
import { MAX_PAUSED_ARTWORKS } from '../../config/arProfiles';
import { arTargetConfig } from '../../config/arTargets';
import { describeError } from '../../cms/errors';
import { getStorage } from '../../cms/storage';
import { buildPackProfile } from '../../cms/targetPack';
import { loadPackTestData } from '../../cms/targetPackService';

// Tests one target pack with the camera, for a signed-in CMS user.
//
// This is a separate screen on purpose. It does not go through the public
// scanner (MindARViewer), does not read or write ar_content, and does not
// touch any campaign's live pointer. It reuses the runtime pieces read-only:
// the same MindAR build, tracking settings, match-order rotation and
// ArtworkManager. Anonymous visitors cannot reach it: the pack and its
// artworks are read through row level security.

type TestInfo = {
  profile: ARProfile;
  version: number;
  campaignId: string;
  campaignName: string;
};

function outline(aspect: number) {
  const halfHeight = aspect / 2;
  const geometry = new BufferGeometry().setFromPoints([
    new Vector3(-0.5, -halfHeight, 0),
    new Vector3(0.5, -halfHeight, 0),
    new Vector3(0.5, halfHeight, 0),
    new Vector3(-0.5, halfHeight, 0),
  ]);

  return new LineLoop(geometry, new LineBasicMaterial({ color: 0x35f08a }));
}

export default function PackTester({
  packId,
  onExit,
}: {
  packId: string;
  onExit: (campaignId: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<TestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    let active = true;

    loadPackTestData(packId).then(
      ({ pack, campaign, items, layers }) => {
        if (!active) {
          return;
        }

        if (pack.status !== 'verified' && pack.status !== 'retired') {
          setError(
            `Target pack v${pack.version} is ${pack.status} and cannot be tested.`,
          );
          return;
        }

        if (items.length !== pack.target_count) {
          setError('This target pack has an incomplete target list.');
          return;
        }

        setInfo({
          version: pack.version,
          campaignId: campaign.id,
          campaignName: campaign.name,
          profile: buildPackProfile({
            pack,
            rotateMatchOrder: campaign.rotate_match_order,
            items,
            layers,
            resolveUrl: (asset) =>
              getStorage(asset.provider).getPublicUrl(asset.bucket, asset.key),
          }),
        });
      },
      (reason: unknown) => {
        if (active) {
          setError(describeError(reason, 'The target pack could not be loaded.'));
        }
      },
    );

    return () => {
      active = false;
    };
  }, [packId]);

  useEffect(() => {
    const container = containerRef.current;

    if (!info || !container) {
      return;
    }

    const { profile } = info;
    let mounted = true;
    let mindarThree: MindARThree | null = null;

    const artworkManager = new ArtworkManager({ maxPaused: MAX_PAUSED_ARTWORKS });
    const resume = () => artworkManager.resumeActive();

    window.addEventListener('pointerdown', resume, { passive: true });

    const start = async () => {
      try {
        mindarThree = new MindARThree({
          container,
          imageTargetSrc: profile.targetSrc,
          maxTrack: 1,
          uiLoading: 'no',
          uiScanning: 'no',
          uiError: 'no',
          ...arTargetConfig.tracking,
        });

        const { renderer, scene, camera } = mindarThree;

        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

        const keyLight = new DirectionalLight(0xffffff, 1);

        keyLight.position.set(0.3, 1, 1);
        scene.add(new HemisphereLight(0xffffff, 0x444444, 1), keyLight);

        profile.artworks.forEach((artwork) => {
          const anchor = mindarThree!.addAnchor(artwork.targetIndex);

          // Always visible proof of where MindAR thinks the trigger is, even
          // for an artwork that has no content layers yet.
          anchor.group.add(outline(artwork.targetHeight / artwork.targetWidth));
          artworkManager.register(artwork, anchor.group);

          anchor.onTargetFound = () => {
            artworkManager.handleTargetFound(artwork.targetIndex);

            if (mounted) {
              setActiveIndex(artwork.targetIndex);
              setSeen((current) => new Set(current).add(artwork.targetIndex));
            }
          };
          anchor.onTargetLost = () => {
            artworkManager.handleTargetLost(artwork.targetIndex);

            if (mounted) {
              setActiveIndex((current) =>
                current === artwork.targetIndex ? null : current,
              );
            }
          };
        });

        await mindarThree.start();

        if (!mounted) {
          return;
        }

        if (profile.rotateMatchOrder) {
          rotateMatchOrder(mindarThree.controller);
        }

        const clock = new Clock();

        renderer.setAnimationLoop(() => {
          artworkManager.update(clock.getDelta());
          renderer.render(scene, camera);
        });
        setStarted(true);
      } catch (reason) {
        console.error('Pack test could not start', reason);

        if (mounted) {
          // MindAR rejects without a value when the camera is refused.
          setError(
            reason === undefined
              ? 'The camera could not be opened. Allow camera access for this site and try again.'
              : describeError(reason, 'The test scanner could not start.'),
          );
        }
      }
    };

    void start();

    return () => {
      mounted = false;
      window.removeEventListener('pointerdown', resume);

      if (mindarThree) {
        mindarThree.renderer.setAnimationLoop(null);
        mindarThree.stop();
        mindarThree.renderer.dispose();
      }

      artworkManager.dispose();
    };
  }, [info]);

  const artworks = info?.profile.artworks ?? [];
  const active = artworks.find((artwork) => artwork.targetIndex === activeIndex);

  return (
    <div className="pack-test">
      <div ref={containerRef} className="ar-container" />

      <div className="pack-test__top">
        <div>
          <strong>TEST, NOT LIVE</strong>
          {info && (
            <div className="pack-test__small">
              {info.campaignName} · target pack v{info.version}
            </div>
          )}
        </div>
        <button
          className="pack-test__button"
          type="button"
          onClick={() => onExit(info?.campaignId ?? null)}
        >
          Exit
        </button>
      </div>

      {error && (
        <div className="pack-test__message" role="alert">
          {error}
        </div>
      )}
      {!error && !started && (
        <div className="pack-test__message" role="status">
          {info ? 'Starting the camera...' : 'Loading the target pack...'}
        </div>
      )}

      {info && !error && (
        <div className="pack-test__bottom">
          <div className="pack-test__status" role="status">
            {active
              ? `Tracking target ${active.targetIndex}: ${active.name}${active.layers.length === 0 ? ' (no content layers yet)' : ''}`
              : started
                ? 'Point the camera at a trigger image.'
                : ''}
          </div>
          <div className="pack-test__targets">
            {artworks.map((artwork) => (
              <span
                key={artwork.targetIndex}
                className={`pack-test__target${seen.has(artwork.targetIndex) ? ' pack-test__target--seen' : ''}${activeIndex === artwork.targetIndex ? ' pack-test__target--active' : ''}`}
              >
                {seen.has(artwork.targetIndex) ? '✓ ' : ''}
                {artwork.targetIndex} {artwork.name}
              </span>
            ))}
          </div>
          <div className="pack-test__small">
            Recognised {seen.size} of {artworks.length}
            {seen.size > 0 && (
              <>
                {' · '}
                <button
                  className="pack-test__link"
                  type="button"
                  onClick={() => setSeen(new Set())}
                >
                  reset
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
