// Pinch-to-zoom: gesture scaling, clamping, Reset, independent targets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArtworkZoom,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampZoom,
  pinchZoom,
  stepZoom,
  touchDistance,
  zoomPercent,
  zoomedScale,
} from '../src/ar/zoom.ts';

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

// A zoom store that records every rescale it asks for.
const recorder = () => {
  const applied: [string, number][] = [];
  const zoom = new ArtworkZoom((id, factor) => applied.push([id, factor]));
  return { zoom, applied };
};

test('range is 0.5x to 3.0x around the configured scale', () => {
  assert.equal(ZOOM_MIN, 0.5);
  assert.equal(ZOOM_MAX, 3);
  assert.equal(ZOOM_DEFAULT, 1);
});

test('clamping', () => {
  assert.equal(clampZoom(0.1), 0.5);
  assert.equal(clampZoom(10), 3);
  assert.equal(clampZoom(1.7), 1.7);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1);
});

test('zoom multiplies the configured scale and nothing else', () => {
  // Legacy overlay scales, PoC scale 1, model-sized scales.
  close(zoomedScale(1.25, 2), 2.5);
  close(zoomedScale(1.85, 0.5), 0.925);
  close(zoomedScale(1, 3), 3);
  close(zoomedScale(1.25, 1), 1.25);
  close(zoomedScale(1.25, 99), 3.75);
});

test('pinch: the zoom follows the change in finger distance', () => {
  close(pinchZoom(1, 100, 200), 2);
  close(pinchZoom(1, 200, 100), 0.5);
  close(pinchZoom(2, 100, 150), 3);
  close(pinchZoom(1.5, 100, 100), 1.5);
});

test('pinch: clamped at both ends, and safe with zero distances', () => {
  assert.equal(pinchZoom(1, 100, 1000), 3);
  assert.equal(pinchZoom(1, 100, 10), 0.5);
  assert.equal(pinchZoom(1.4, 0, 100), 1.4);
  assert.equal(pinchZoom(1.4, 100, 0), 1.4);
});

test('finger distance', () => {
  assert.equal(touchDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(touchDistance({ x: 10, y: 10 }, { x: 10, y: 10 }), 0);
});

test('+ and - step by 25% and return exactly to 100%', () => {
  close(stepZoom(1, 1), ZOOM_STEP);
  close(stepZoom(1, -1), 1 / ZOOM_STEP);
  assert.equal(stepZoom(stepZoom(1, 1), -1), 1);
  assert.equal(stepZoom(stepZoom(stepZoom(1, -1), -1), 1) > 0, true);

  let factor = 1;
  for (let i = 0; i < 20; i += 1) factor = stepZoom(factor, 1);
  assert.equal(factor, 3);
  for (let i = 0; i < 40; i += 1) factor = stepZoom(factor, -1);
  assert.equal(factor, 0.5);
});

test('percentage shown on screen', () => {
  assert.equal(zoomPercent(1), 100);
  assert.equal(zoomPercent(1.25), 125);
  assert.equal(zoomPercent(0.5), 50);
  assert.equal(zoomPercent(7), 300);
});

test('nothing happens while no target is tracked', () => {
  const { zoom, applied } = recorder();

  assert.equal(zoom.current(), null);
  assert.equal(zoom.zoomTo(2), null);
  assert.equal(zoom.step(1), null);
  assert.equal(zoom.reset(), null);
  assert.equal(zoom.pinchStart(100), false);
  assert.equal(zoom.pinchMove(200), null);
  assert.deepEqual(applied, []);
});

test('a pinch gesture zooms the tracked artwork and stops at the limits', () => {
  const { zoom, applied } = recorder();

  zoom.setActive('art-a');
  assert.equal(zoom.pinchStart(100), true);
  close(zoom.pinchMove(150) ?? 0, 1.5);
  close(zoom.pinchMove(250) ?? 0, 2.5);
  assert.equal(zoom.pinchMove(900), 3);
  assert.equal(zoom.pinchMove(10), 0.5);
  zoom.pinchEnd();
  assert.equal(zoom.pinching, false);
  assert.equal(zoom.pinchMove(300), null, 'moves after the pinch ended are ignored');
  assert.equal(zoom.current(), 0.5);
  assert.deepEqual(applied.map(([id]) => id), ['art-a', 'art-a', 'art-a', 'art-a']);
});

test('a second pinch continues from the current zoom', () => {
  const { zoom } = recorder();

  zoom.setActive('art-a');
  zoom.pinchStart(100);
  zoom.pinchMove(200);
  zoom.pinchEnd();
  zoom.pinchStart(300);
  close(zoom.pinchMove(450) ?? 0, 3);
  zoom.pinchEnd();
  zoom.pinchStart(300);
  close(zoom.pinchMove(150) ?? 0, 1.5);
});

test('Reset returns the tracked artwork to its configured scale', () => {
  const { zoom, applied } = recorder();

  zoom.setActive('art-a');
  zoom.zoomTo(2.2);
  assert.equal(zoom.reset(), 1);
  assert.equal(zoom.current(), 1);
  assert.deepEqual(applied.at(-1), ['art-a', 1]);
  assert.equal(zoom.reset(), 1);
  assert.equal(applied.length, 2, 'a reset at 100% does not rescale again');
});

test('each artwork keeps its own zoom', () => {
  const { zoom } = recorder();

  zoom.setActive('art-a');
  zoom.zoomTo(2);
  zoom.setActive('art-b');
  assert.equal(zoom.current(), 1, 'a new target starts at 100%');
  zoom.zoomTo(0.5);
  zoom.setActive('art-a');
  assert.equal(zoom.current(), 2);
  zoom.setActive('art-b');
  assert.equal(zoom.current(), 0.5);
  zoom.reset();
  zoom.setActive('art-a');
  assert.equal(zoom.current(), 2, 'resetting one target leaves the other alone');
});

test('zoom survives losing and regaining the target', () => {
  const { zoom } = recorder();

  zoom.setActive('art-a');
  zoom.zoomTo(1.8);
  zoom.setActive(null);
  assert.equal(zoom.current(), null);
  assert.equal(zoom.factorFor('art-a'), 1.8);
  zoom.setActive('art-a');
  assert.equal(zoom.current(), 1.8);
});

test('switching target in the middle of a pinch ends that pinch', () => {
  const { zoom } = recorder();

  zoom.setActive('art-a');
  zoom.pinchStart(100);
  zoom.pinchMove(200);
  zoom.setActive('art-b');
  assert.equal(zoom.pinching, false);
  assert.equal(zoom.pinchMove(400), null);
  assert.equal(zoom.current(), 1, 'the pinch on A did not spill onto B');
  zoom.setActive('art-a');
  assert.equal(zoom.current(), 2);
});

test('losing the target in the middle of a pinch ends that pinch', () => {
  const { zoom } = recorder();

  zoom.setActive('art-a');
  zoom.pinchStart(100);
  zoom.setActive(null);
  assert.equal(zoom.pinching, false);
  zoom.setActive('art-a');
  assert.equal(zoom.pinchMove(300), null);
  assert.equal(zoom.current(), 1);
});

// ------------------------------------------------- the real ArtworkManager
// Bundled with esbuild (installed with Vite), with the video and model layer
// modules replaced by fakes, so the actual tracking lifecycle runs in Node.

type FakeLayer = { kind: string; artworkId: string; zoom: number | null; disposed: boolean };

async function loadManager() {
  const { build } = await import('esbuild');
  const fakes = `
    export const created = [];
    const make = (kind, artwork, zoomable) => {
      const record = { kind, artworkId: artwork.id, zoom: null, disposed: false };
      created.push(record);
      return {
        object3D: {},
        activate() {}, resume() {}, pause() {}, update() {},
        dispose() { record.disposed = true; },
        ...(zoomable ? { setZoom(factor) { record.zoom = factor; } } : {}),
      };
    };
    export async function createVideoLayer(config, artwork) { return make('video', artwork, true); }
    export async function createModelLayer(config) { return make('model', { id: config.artworkId }, false); }
  `;
  const result = await build({
    stdin: {
      contents: `export { ArtworkManager } from './src/ar/artworkManager.ts';
                 export { created } from 'fake-layers';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    plugins: [{
      name: 'fake-layers',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^(\.\/videoLayer|\.\/modelLayer|fake-layers)$/ }, () => ({
          path: 'fake-layers', namespace: 'fake',
        }));
        pluginBuild.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: fakes, loader: 'js' }));
      },
    }],
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;

  return (await import(url)) as {
    ArtworkManager: new (options: { maxPaused: number }) => {
      register(artwork: unknown, group: { add(object: unknown): void }): void;
      handleTargetFound(index: number): void;
      handleTargetLost(index: number): void;
      dispose(): void;
      zoom: ArtworkZoom;
    };
    created: FakeLayer[];
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const group = { add() {} };
const video = { type: 'VIDEO', src: 'v.mp4', videoMode: 'normal', fit: 'video', scale: 1, position: [0, 0, 0], loop: true, muted: true };
const artwork = (id: string, targetIndex: number, layers: unknown[]) =>
  ({ id, name: id, targetIndex, targetWidth: 1000, targetHeight: 1000, layers });

test('ArtworkManager: zoom follows the tracked target through found, lost and found again', async () => {
  const { ArtworkManager, created } = await loadManager();
  created.length = 0;
  const manager = new ArtworkManager({ maxPaused: 1 });
  const model = { type: 'MODEL_3D', src: 'm.glb', scale: 1, position: [0, 0, 0], rotation: [0, 0, 0], artworkId: 'a' };

  manager.register(artwork('a', 0, [video, model]), group);
  manager.register(artwork('b', 1, [video]), group);

  manager.handleTargetFound(0);
  await settle();
  const [videoA, modelA] = created;
  assert.equal(videoA.zoom, 1, 'a freshly loaded video starts at its configured scale');

  manager.zoom.zoomTo(2);
  assert.equal(videoA.zoom, 2);
  assert.equal(modelA.zoom, null, 'the 3D model is never scaled');

  manager.handleTargetLost(0);
  assert.equal(manager.zoom.current(), null, 'nothing to zoom while the target is lost');
  assert.equal(manager.zoom.zoomTo(3), null);
  assert.equal(videoA.zoom, 2, 'losing the target keeps its zoom');

  manager.handleTargetFound(1);
  await settle();
  const videoB = created.find((layer) => layer.artworkId === 'b') as FakeLayer;
  assert.equal(manager.zoom.current(), 1, 'the other target has its own zoom');
  manager.zoom.zoomTo(0.5);
  assert.equal(videoB.zoom, 0.5);
  assert.equal(videoA.zoom, 2, 'zooming B leaves A alone');

  manager.handleTargetFound(0);
  assert.equal(manager.zoom.current(), 2, 'A comes back at the zoom it had');
  manager.zoom.reset();
  assert.equal(videoA.zoom, 1);
  assert.equal(videoB.zoom, 0.5);
  manager.dispose();
});

test('ArtworkManager: an artwork unloaded to save memory comes back at its zoom', async () => {
  const { ArtworkManager, created } = await loadManager();
  created.length = 0;
  // maxPaused 0: only the current artwork stays loaded.
  const manager = new ArtworkManager({ maxPaused: 0 });

  manager.register(artwork('a', 0, [video]), group);
  manager.register(artwork('b', 1, [video]), group);

  manager.handleTargetFound(0);
  await settle();
  manager.zoom.zoomTo(2.5);

  manager.handleTargetFound(1);
  await settle();
  assert.equal(created[0].disposed, true, 'A was freed while B is tracked');

  manager.handleTargetFound(0);
  await settle();
  const reloaded = created.filter((layer) => layer.artworkId === 'a').at(-1) as FakeLayer;
  assert.notEqual(reloaded, created[0], 'A was loaded again as a new layer');
  assert.equal(reloaded.zoom, 2.5, 'and was given back its zoom');
  manager.dispose();
});

test('ArtworkManager: zoom set while the video is still loading is applied when it arrives', async () => {
  const { ArtworkManager, created } = await loadManager();
  created.length = 0;
  const manager = new ArtworkManager({ maxPaused: 1 });

  manager.register(artwork('a', 0, [video]), group);
  manager.handleTargetFound(0);
  manager.zoom.zoomTo(1.6);
  await settle();
  assert.equal(created[0].zoom, 1.6);
  manager.dispose();
});
