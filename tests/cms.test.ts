// Run with: npm test   (Node 24 runs TypeScript directly; no test framework.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MINDAR_COMPILER_VERSION,
  manifestToProfile,
  validateManifest,
  type ReleaseManifest,
} from '../src/cms/manifest.ts';
import {
  extensionOf,
  mediaKey,
  scannerKey,
  triggerKey,
} from '../src/cms/storageKeys.ts';
import {
  campaignActions,
  formatBytes,
  formatDuration,
  hasRole,
  isValidSlug,
  slugify,
} from '../src/cms/validation.ts';

const SHA = 'a'.repeat(64);
const ID = '0b9f6c1e-2f43-4c8e-9d0a-6f1f8b7a5c11';

test('storage keys follow the versioned layout', () => {
  assert.equal(mediaKey(ID, SHA, 'mp4'), `media/${ID}/${SHA}.mp4`);
  assert.equal(
    triggerKey('camp-1', 'art-1', SHA, 'png'),
    `triggers/camp-1/art-1/${SHA}.png`,
  );
  assert.equal(
    scannerKey('scannerBorder', SHA, 'png'),
    `scanner/scannerBorder/${SHA}.png`,
  );
});

test('storage keys never use the old fixed live/ path', () => {
  for (const key of [
    mediaKey(ID, SHA, 'mp4'),
    triggerKey(ID, ID, SHA, 'jpg'),
    scannerKey('animation01', SHA, 'mp4'),
  ]) {
    assert.ok(!key.startsWith('live/'));
    assert.ok(key.includes(SHA), 'the key must contain the content hash');
  }
});

test('different bytes always get a different key', () => {
  assert.notEqual(
    scannerKey('animation01', SHA, 'mp4'),
    scannerKey('animation01', 'b'.repeat(64), 'mp4'),
  );
});

test('storage keys reject unsafe parts', () => {
  assert.throws(() => mediaKey('../evil', SHA, 'mp4'));
  assert.throws(() => mediaKey(ID, 'not-a-hash', 'mp4'));
  assert.throws(() => mediaKey(ID, SHA.toUpperCase(), 'mp4'));
  assert.throws(() => triggerKey(ID, 'a/b', SHA, 'png'));
  assert.throws(() => scannerKey('key', SHA, 'p/ng'));
});

test('extensionOf reads the name, then the MIME type', () => {
  assert.equal(extensionOf('Clip.MP4'), 'mp4');
  assert.equal(extensionOf('photo.JPEG'), 'jpg');
  assert.equal(extensionOf('model', 'model/gltf-binary'), 'glb');
  assert.equal(extensionOf('weird.file name!', 'image/png'), 'png');
  assert.equal(extensionOf('noextension'), 'bin');
});

test('slugify produces slugs the database accepts', () => {
  assert.equal(slugify('Áo Thun Hè 2026'), 'ao-thun-he-2026');
  assert.equal(slugify('  Đặc biệt -- Tết!  '), 'dac-biet-tet');
  assert.ok(isValidSlug(slugify('Summer   Drop #3')));
  assert.equal(slugify('!!!'), '');
});

test('isValidSlug matches the database CHECK', () => {
  assert.ok(isValidSlug('summer-2026'));
  assert.ok(!isValidSlug('Summer'));
  assert.ok(!isValidSlug('a--b'));
  assert.ok(!isValidSlug('-a'));
  assert.ok(!isValidSlug(''));
  assert.ok(!isValidSlug('a'.repeat(65)));
});

test('hasRole orders viewer < editor < admin and treats no role as no access', () => {
  assert.ok(hasRole('admin', 'editor'));
  assert.ok(hasRole('editor', 'viewer'));
  assert.ok(!hasRole('editor', 'admin'));
  assert.ok(!hasRole('viewer', 'editor'));
  assert.ok(!hasRole(null, 'viewer'));
});

test('campaignActions: only an Admin is offered archive/restore of the live campaign', () => {
  const live = { live_release_id: ID };
  const notLive = { live_release_id: null };
  const none = { canEdit: false, canChangeStatus: false };

  assert.deepEqual(campaignActions('admin', live), { canEdit: true, canChangeStatus: true });
  assert.deepEqual(campaignActions('admin', notLive), { canEdit: true, canChangeStatus: true });
  assert.deepEqual(campaignActions('editor', live), { canEdit: true, canChangeStatus: false });
  assert.deepEqual(campaignActions('editor', notLive), { canEdit: true, canChangeStatus: true });
  assert.deepEqual(campaignActions('viewer', live), none);
  assert.deepEqual(campaignActions('viewer', notLive), none);
  assert.deepEqual(campaignActions(null, notLive), none);
});

test('formatters', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(29255441), '27.9 MB');
  assert.equal(formatDuration(75.4), '1:15');
});

const asset = (key: string) => ({ provider: 'supabase', bucket: 'ar-media', key });

const manifest = (): ReleaseManifest => ({
  schemaVersion: 1,
  campaignId: ID,
  campaignSlug: 'summer-2026',
  releaseId: ID,
  version: 3,
  createdAt: '2026-10-13T00:00:00Z',
  targetPack: {
    id: ID,
    version: 3,
    asset: asset('targets/c/v3/targets.mind'),
    sha256: SHA,
    targetCount: 2,
    compilerVersion: MINDAR_COMPILER_VERSION,
  },
  rotateMatchOrder: true,
  artworks: [
    {
      id: 'art-a',
      name: 'Artwork A',
      targetIndex: 0,
      targetWidth: 1254,
      targetHeight: 1254,
      layers: [
        {
          type: 'VIDEO',
          mediaId: 'm1',
          asset: asset('media/m1/x.mp4'),
          videoMode: 'alpha-packed',
          fit: 'video',
          scale: 1,
          position: [0, 0, 0.01],
          loop: true,
          muted: true,
        },
      ],
    },
    {
      id: 'art-b',
      name: 'Artwork B',
      targetIndex: 1,
      targetWidth: 745,
      targetHeight: 708,
      layers: [
        {
          type: 'MODEL_3D',
          mediaId: 'm2',
          asset: asset('media/m2/y.glb'),
          scale: 0.25,
          position: [0, -0.22, 0.2],
          rotation: [90, 0, 0],
        },
      ],
    },
  ],
});

test('a complete manifest is valid', () => {
  assert.deepEqual(validateManifest(manifest()), []);
});

test('the compiler version is pinned to MindAR 1.2.5', () => {
  assert.equal(MINDAR_COMPILER_VERSION, '1.2.5');

  const wrong = manifest();
  wrong.targetPack.compilerVersion = '1.2.6';
  assert.match(validateManifest(wrong).join('\n'), /compilerVersion/);
});

test('validateManifest catches target index mistakes', () => {
  const duplicate = manifest();
  duplicate.artworks[1].targetIndex = 0;
  assert.match(validateManifest(duplicate).join('\n'), /duplicate targetIndex/);

  const outside = manifest();
  outside.artworks[1].targetIndex = 2;
  assert.match(validateManifest(outside).join('\n'), /outside the target pack/);
});

test('validateManifest requires a complete consecutive target index set', () => {
  const shorter = manifest();
  shorter.artworks.pop();
  assert.match(validateManifest(shorter).join('\n'), /artworks count/);
  assert.match(validateManifest(shorter).join('\n'), /missing targetIndex 1/);

  const gap = manifest();
  gap.artworks[1].targetIndex = 2;
  assert.match(validateManifest(gap).join('\n'), /missing targetIndex 1/);
});

test('validateManifest rejects incomplete input', () => {
  assert.notDeepEqual(validateManifest(null), []);
  assert.notDeepEqual(validateManifest({ schemaVersion: 2 }), []);

  const noSize = manifest() as unknown as { artworks: Record<string, unknown>[] };
  delete noSize.artworks[0].targetWidth;
  assert.match(validateManifest(noSize).join('\n'), /targetWidth/);

  const badLayer = manifest() as unknown as {
    artworks: { layers: Record<string, unknown>[] }[];
  };
  delete badLayer.artworks[0].layers[0].videoMode;
  assert.match(validateManifest(badLayer).join('\n'), /videoMode/);
});

test('manifestToProfile yields the runtime ARProfile shape', () => {
  const profile = manifestToProfile(
    manifest(),
    (ref) => `https://cdn.example/${ref.bucket}/${ref.key}`,
  );

  assert.equal(
    profile.targetSrc,
    'https://cdn.example/ar-media/targets/c/v3/targets.mind',
  );
  assert.equal(profile.rotateMatchOrder, true);
  assert.equal(profile.artworks.length, 2);
  assert.deepEqual(profile.artworks[0], {
    id: 'art-a',
    name: 'Artwork A',
    targetIndex: 0,
    targetWidth: 1254,
    targetHeight: 1254,
    layers: [
      {
        type: 'VIDEO',
        src: 'https://cdn.example/ar-media/media/m1/x.mp4',
        videoMode: 'alpha-packed',
        fit: 'video',
        scale: 1,
        position: [0, 0, 0.01],
        loop: true,
        muted: true,
      },
    ],
  });
  assert.deepEqual(profile.artworks[1].layers[0], {
    type: 'MODEL_3D',
    src: 'https://cdn.example/ar-media/media/m2/y.glb',
    scale: 0.25,
    position: [0, -0.22, 0.2],
    rotation: [90, 0, 0],
  });
});
