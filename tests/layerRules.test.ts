import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultLayerInput,
  LAYER_LIMITS,
  validateLayerInput,
} from '../src/cms/layerRules.ts';

const video = {
  id: 'video-1',
  type: 'VIDEO' as const,
  status: 'active' as const,
  video_mode: 'normal' as const,
};

const model = {
  id: 'model-1',
  type: 'MODEL_3D' as const,
  status: 'active' as const,
  video_mode: null,
};

test('layer defaults match the Phase 2C.1 schema', () => {
  const a = defaultLayerInput('VIDEO', video.id, 2);
  const b = defaultLayerInput('MODEL_3D', model.id);
  assert.equal(a.fit, 'target');
  assert.equal(b.fit, null);
  assert.equal(a.scale, 1);
  assert.equal(a.sort_order, 2);
  assert.equal(validateLayerInput(a, video), null);
  assert.equal(validateLayerInput(b, model), null);
});

test('video layers require the correct active media and a video fit', () => {
  const valid = defaultLayerInput('VIDEO', video.id);
  assert.equal(validateLayerInput({ ...valid, fit: 'video' }, video), null);
  assert.match(validateLayerInput(valid, null) ?? '', /choose a file/i);
  assert.match(
    validateLayerInput(valid, { ...video, status: 'archived' }) ?? '',
    /archived/i,
  );
  assert.match(validateLayerInput(valid, { ...video, video_mode: null }) ?? '', /video mode/i);
  assert.match(validateLayerInput({ ...valid, fit: null }, video) ?? '', /fit/i);
  assert.match(validateLayerInput(valid, model) ?? '', /choose a file/i);
});

test('model layers require model media and no video fit', () => {
  const valid = defaultLayerInput('MODEL_3D', model.id);
  assert.equal(validateLayerInput(valid, model), null);
  assert.match(validateLayerInput({ ...valid, fit: 'target' }, model) ?? '', /no.*fit/i);
  assert.match(
    validateLayerInput({ ...valid, layer_type: 'VIDEO' }, model) ?? '',
    /media type/i,
  );
});

test('scale position and rotation reject non-finite or out-of-range values', () => {
  const base = defaultLayerInput('MODEL_3D', model.id);
  assert.equal(validateLayerInput({ ...base, scale: LAYER_LIMITS.scale.min }, model), null);
  assert.equal(validateLayerInput({ ...base, scale: LAYER_LIMITS.scale.max }, model), null);
  for (const value of [Number.NaN, Infinity, -Infinity, 0, 10.1]) {
    assert.match(validateLayerInput({ ...base, scale: value }, model) ?? '', /scale/i);
  }
  for (const value of [Number.NaN, Infinity, -5.01, 5.01]) {
    assert.match(validateLayerInput({ ...base, position_z: value }, model) ?? '', /position/i);
  }
  for (const value of [Number.NaN, Infinity, -360.01, 360.01]) {
    assert.match(validateLayerInput({ ...base, rotation_x: value }, model) ?? '', /rotation/i);
  }
});

test('order must be a non-negative integer; flags must be boolean', () => {
  const base = defaultLayerInput('VIDEO', video.id);
  for (const value of [-1, 1.5, Number.NaN, Infinity]) {
    assert.match(validateLayerInput({ ...base, sort_order: value }, video) ?? '', /order/i);
  }
  assert.equal(validateLayerInput({ ...base, sort_order: 0 }, video), null);
  assert.match(
    validateLayerInput({ ...base, enabled: null as unknown as boolean }, video) ?? '',
    /on or off/i,
  );
});
