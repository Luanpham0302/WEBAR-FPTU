import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AR_MEDIA_ALLOWED_MIME_TYPES,
  AR_MEDIA_MAX_BYTES,
  acceptFor,
  libraryFormatOf,
  type LibraryKind,
} from '../src/cms/mediaRules.ts';

const file = (name: string, type: string, size = 1024) => ({ name, type, size });

function stored(name: string, type: string, kind: LibraryKind) {
  const result = libraryFormatOf(file(name, type), kind);
  assert.ok('format' in result, `${name} (${type || 'no type'}) should be accepted`);
  return result.format;
}

function refused(name: string, type: string, kind: LibraryKind, size?: number) {
  const result = libraryFormatOf(file(name, type, size), kind);
  assert.ok('error' in result, `${name} (${type || 'no type'}) should be refused`);
}

test('videos: MP4 and WebM only, stored with their own type', () => {
  assert.deepEqual(
    [stored('clip.mp4', 'video/mp4', 'VIDEO'), stored('CLIP.MP4', 'video/mp4', 'VIDEO')]
      .map((f) => [f.extension, f.mimeType]),
    [['mp4', 'video/mp4'], ['mp4', 'video/mp4']],
  );
  assert.equal(stored('loop.webm', 'video/webm', 'VIDEO').mimeType, 'video/webm');

  refused('clip.mkv', 'video/x-matroska', 'VIDEO');
  refused('clip.mov', 'video/quicktime', 'VIDEO');
  refused('clip.avi', 'video/x-msvideo', 'VIDEO');
  refused('clip', 'video/mp4', 'VIDEO');
});

test('a .glb is stored as model/gltf-binary whatever type the browser reports', () => {
  for (const reported of ['', 'application/octet-stream', 'model/gltf-binary']) {
    const format = stored('shirt.glb', reported, 'MODEL_3D');
    assert.equal(format.extension, 'glb');
    assert.equal(format.mimeType, 'model/gltf-binary');
  }
  refused('shirt.gltf', 'model/gltf+json', 'MODEL_3D');
  refused('shirt.glb', 'text/html', 'MODEL_3D');
});

test('images: PNG, JPEG and WebP; never SVG or GIF', () => {
  assert.equal(stored('a.png', 'image/png', 'IMAGE').extension, 'png');
  assert.deepEqual(
    [stored('a.jpeg', 'image/jpeg', 'IMAGE').extension, stored('a.jpg', 'image/jpeg', 'IMAGE').extension],
    ['jpg', 'jpg'],
  );
  assert.equal(stored('a.webp', 'image/webp', 'IMAGE').mimeType, 'image/webp');

  refused('logo.svg', 'image/svg+xml', 'IMAGE');
  refused('anim.gif', 'image/gif', 'IMAGE');
});

test('a reported type must agree with the file name', () => {
  refused('page.mp4', 'text/html', 'VIDEO');
  refused('logo.png', 'image/svg+xml', 'IMAGE');
  refused('clip.webm', 'video/mp4', 'VIDEO');
  refused('page.html', 'text/html', 'VIDEO');
  refused('a.png', 'image/png', 'VIDEO');
});

test('size: empty files and files above 50 MB are refused', () => {
  assert.equal(AR_MEDIA_MAX_BYTES, 50 * 1024 * 1024);
  refused('clip.mp4', 'video/mp4', 'VIDEO', 0);
  stored('clip.mp4', 'video/mp4', 'VIDEO');
  assert.ok('format' in libraryFormatOf(file('clip.mp4', 'video/mp4', AR_MEDIA_MAX_BYTES), 'VIDEO'));
  refused('clip.mp4', 'video/mp4', 'VIDEO', AR_MEDIA_MAX_BYTES + 1);
  // The 38.87 MB video of Release v3 still fits.
  assert.ok('format' in libraryFormatOf(file('v3.mp4', 'video/mp4', 40_757_821), 'VIDEO'));
});

test('the bucket allowlist covers every format and the .mind pack, and nothing executable', () => {
  assert.deepEqual([...AR_MEDIA_ALLOWED_MIME_TYPES].sort(), [
    'application/octet-stream', 'image/jpeg', 'image/png', 'image/webp',
    'model/gltf-binary', 'video/mp4', 'video/webm',
  ]);
  for (const forbidden of ['text/html', 'image/svg+xml', 'video/quicktime', 'application/javascript']) {
    assert.ok(!AR_MEDIA_ALLOWED_MIME_TYPES.includes(forbidden), forbidden);
  }
});

test('the file picker offers exactly the accepted formats', () => {
  assert.equal(acceptFor('VIDEO'), '.mp4,video/mp4,.webm,video/webm');
  assert.equal(acceptFor('MODEL_3D'), '.glb,model/gltf-binary');
  assert.equal(acceptFor('IMAGE'), '.png,image/png,.jpg,.jpeg,image/jpeg,.webp,image/webp');
});
