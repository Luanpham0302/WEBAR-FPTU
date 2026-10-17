import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseScannerProfile, type ScannerSources } from '../src/cms/scannerSource.ts';

const TOKEN = '0b9f6c1e-2f43-4c8e-9d0a-6f1f8b7a5c11';
const MANIFEST = { schemaVersion: 1, releaseId: 'r3' };

function sources(overrides: Partial<ScannerSources<string>> = {}) {
  const calls: string[] = [];
  const s: ScannerSources<string> = {
    poc: 'poc',
    legacy: 'legacy',
    fetchLive: async () => { calls.push('live'); return MANIFEST; },
    fetchPreview: async (token) => { calls.push('preview:' + token); return MANIFEST; },
    toProfile: (manifest) => { calls.push('toProfile'); return manifest === MANIFEST ? 'release' : 'other'; },
    onLiveUnavailable: () => { calls.push('warn'); },
    ...overrides,
  };
  return { s, calls };
}

test('?profile=poc is the bundled demo and never asks the CMS', async () => {
  const { s, calls } = sources();
  assert.equal(await chooseScannerProfile('?profile=poc', s), 'poc');
  assert.equal(await chooseScannerProfile('?profile=poc&preview=' + TOKEN, s), 'poc');
  assert.deepEqual(calls, []);
});

test('the published release is shown when there is one', async () => {
  const { s, calls } = sources();
  assert.equal(await chooseScannerProfile('', s), 'release');
  assert.deepEqual(calls, ['live', 'toProfile']);
});

test('nothing published, or the CMS cannot be read: the legacy scanner', async () => {
  for (const value of [null, undefined]) {
    const { s } = sources({ fetchLive: async () => value });
    assert.equal(await chooseScannerProfile('', s), 'legacy');
  }

  const { s, calls } = sources({ fetchLive: async () => { throw new Error('Failed to fetch'); } });
  assert.equal(await chooseScannerProfile('', s), 'legacy');
  assert.deepEqual(calls, ['warn']);
});

test('a published manifest that cannot be used fails closed, whatever the error', async () => {
  // The old loader only re-threw three known messages; any other error
  // (a TypeError from an unexpected shape, say) silently showed legacy content.
  for (const error of [
    new Error('Invalid release manifest: unsupported schemaVersion: 2'),
    new TypeError("Cannot read properties of undefined (reading 'key')"),
    new Error('Release contains an unsupported or unsafe media reference.'),
    new RangeError('anything'),
  ]) {
    const { s, calls } = sources({ toProfile: () => { throw error; } });
    await assert.rejects(chooseScannerProfile('', s), error);
    assert.ok(!calls.includes('warn'), 'not treated as "CMS unavailable"');
  }

  // A falsy but non-null value is a manifest problem too, not "nothing published".
  for (const value of [false, 0, '']) {
    const { s } = sources({ fetchLive: async () => value, toProfile: () => { throw new Error('Invalid release manifest: x'); } });
    await assert.rejects(chooseScannerProfile('', s), /Invalid release manifest/);
  }
});

test('a preview is private and fails closed: never the live release or legacy instead', async () => {
  const { s, calls } = sources();
  assert.equal(await chooseScannerProfile('?preview=' + TOKEN, s), 'release');
  assert.deepEqual(calls, ['preview:' + TOKEN, 'toProfile']);

  await assert.rejects(chooseScannerProfile('?preview=not-a-uuid', sources().s), /Invalid preview token/);
  await assert.rejects(chooseScannerProfile('?preview=', sources().s), /Invalid preview token/);

  const failing = sources({ fetchPreview: async () => { throw new Error('Sign in to the CMS to preview a release.'); } });
  await assert.rejects(chooseScannerProfile('?preview=' + TOKEN, failing.s), /Sign in/);
  assert.ok(!failing.calls.includes('live'));
});
