// Phase 2B: trigger rules and target pack verification.
// The pack tests read the two real .mind files shipped in public/targets/,
// so they also prove that neither file was changed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decode } from '@msgpack/msgpack';
import { MINDAR_COMPILER_VERSION } from '../src/cms/manifest.ts';
import { targetPackKey } from '../src/cms/storageKeys.ts';
import {
  buildPackItems,
  buildPackProfile,
  computeSourceHash,
  gradeFeatureCount,
  gradeTarget,
  orderCompileSources,
  summarizeTargets,
  verifyCompiledTargets,
  type CompileSource,
  type CompiledTarget,
} from '../src/cms/targetPack.ts';
import {
  TRIGGER_RULES,
  checkTriggerImage,
  findDuplicateTrigger,
  hasBlockingIssue,
} from '../src/cms/triggerRules.ts';

const sha = (letter: string) => letter.repeat(64);
const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

const readMind = (path: string) => {
  const bytes = readFileSync(path);
  const { v, dataList } = decode(bytes) as { v: number; dataList: unknown };

  return {
    version: v,
    targets: summarizeTargets(dataList),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

// ---------------------------------------------------------------- trigger rules

const image = (width: number, height: number, extra = {}) => ({
  mimeType: 'image/png',
  width,
  height,
  fileSize: 1_000_000,
  ...extra,
});

test('the existing production triggers pass the trigger rules', () => {
  // PoC triggers, the Coc AI trigger, and the three legacy shirt triggers.
  for (const [width, height] of [
    [1254, 1254],
    [745, 708],
    [2000, 3000],
    [2564, 2540],
    [3000, 2000],
  ]) {
    assert.deepEqual(checkTriggerImage(image(width, height)), [], `${width}x${height}`);
  }
});

test('format: only PNG and JPEG are accepted', () => {
  assert.deepEqual(checkTriggerImage(image(1000, 1000, { mimeType: 'image/jpeg' })), []);

  for (const mimeType of ['image/webp', 'image/gif', 'image/svg+xml', '']) {
    const issues = checkTriggerImage(image(1000, 1000, { mimeType }));
    assert.deepEqual(codes(issues), ['format']);
    assert.ok(hasBlockingIssue(issues));
  }
});

test('resolution: too small blocks, small warns', () => {
  const tooSmall = checkTriggerImage(image(200, 800));
  assert.ok(codes(tooSmall).includes('too-small'));
  assert.ok(hasBlockingIssue(tooSmall));

  const small = checkTriggerImage(image(400, 400));
  assert.deepEqual(codes(small), ['small']);
  assert.ok(!hasBlockingIssue(small));

  assert.deepEqual(checkTriggerImage(image(TRIGGER_RULES.recommendedMinSide, 600)), []);
});

test('resolution: very large warns, oversized blocks', () => {
  const large = checkTriggerImage(image(5000, 5000));
  assert.deepEqual(codes(large), ['large']);
  assert.ok(!hasBlockingIssue(large));

  const tooLarge = checkTriggerImage(image(9000, 9000));
  assert.deepEqual(codes(tooLarge), ['too-large']);
  assert.ok(hasBlockingIssue(tooLarge));
});

test('aspect ratio: elongated warns, extreme blocks, either orientation', () => {
  assert.deepEqual(codes(checkTriggerImage(image(3000, 1000))), ['aspect']);
  assert.deepEqual(codes(checkTriggerImage(image(1000, 3000))), ['aspect']);

  const extreme = checkTriggerImage(image(4100, 1000));
  assert.ok(codes(extreme).includes('aspect-extreme'));
  assert.ok(hasBlockingIssue(extreme));
});

test('file size and unreadable size block', () => {
  assert.deepEqual(
    codes(checkTriggerImage(image(1000, 1000, { fileSize: 21 * 1024 * 1024 }))),
    ['file-size'],
  );
  assert.ok(hasBlockingIssue(checkTriggerImage(image(0, 0))));
});

test('duplicate SHA-256: found on another active artwork only', () => {
  const artworks = [
    { id: 'a', name: 'A', status: 'ready', trigger_sha256: sha('a') },
    { id: 'b', name: 'B', status: 'draft', trigger_sha256: sha('b') },
    { id: 'c', name: 'C', status: 'archived', trigger_sha256: sha('c') },
    { id: 'd', name: 'D', status: 'draft', trigger_sha256: null },
  ];

  assert.equal(findDuplicateTrigger(sha('a'), 'b', artworks)?.name, 'A');
  assert.equal(findDuplicateTrigger(sha('b'), 'a', artworks)?.name, 'B');
  // Re-uploading the same image to the same artwork is not a duplicate.
  assert.equal(findDuplicateTrigger(sha('a'), 'a', artworks), null);
  // An archived artwork is never compiled, so it does not block.
  assert.equal(findDuplicateTrigger(sha('c'), 'a', artworks), null);
  assert.equal(findDuplicateTrigger(sha('z'), 'a', artworks), null);
});

// ------------------------------------------------------------ compile ordering

const artwork = (
  id: string,
  sortOrder: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name: `Artwork ${id}`,
  status: 'ready',
  sort_order: sortOrder,
  created_at: '2026-10-01T00:00:00Z',
  trigger_media_id: `media-${id}`,
  trigger_sha256: sha(id),
  trigger_width: 1254,
  trigger_height: 1254,
  ...extra,
});

test('compile order: Ready artworks only, by sort_order, indexes 0..n-1', () => {
  const sources = orderCompileSources([
    artwork('c', 3),
    artwork('a', 1),
    artwork('d', 2, { status: 'draft' }),
    artwork('e', 0, { status: 'archived' }),
    artwork('b', 2),
  ]);

  assert.deepEqual(sources.map((s) => s.artworkId), ['a', 'b', 'c']);
  assert.deepEqual(sources.map((s) => s.targetIndex), [0, 1, 2]);
  assert.equal(sources[1].triggerMediaId, 'media-b');
  assert.equal(sources[1].sha256, sha('b'));
});

test('compile order is the same whatever order the rows arrive in', () => {
  const rows = [
    artwork('a', 1, { created_at: '2026-10-03T00:00:00Z' }),
    artwork('b', 1, { created_at: '2026-10-02T00:00:00Z' }),
    artwork('c', 1, { created_at: '2026-10-02T00:00:00Z' }),
    artwork('d', 0),
  ];
  const expected = ['d', 'b', 'c', 'a'];

  assert.deepEqual(orderCompileSources(rows).map((s) => s.artworkId), expected);
  assert.deepEqual(
    orderCompileSources([...rows].reverse()).map((s) => s.artworkId),
    expected,
  );
});

test('an artwork without a complete trigger is never compiled', () => {
  assert.deepEqual(
    orderCompileSources([
      artwork('a', 1, { trigger_media_id: null }),
      artwork('b', 2, { trigger_width: null }),
    ]),
    [],
  );
});

test('source hash depends on images, order, size and compiler version', async () => {
  const [a, b] = orderCompileSources([artwork('a', 1), artwork('b', 2)]);
  const base = await computeSourceHash([a, b], '1.2.5');

  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(await computeSourceHash([a, b], '1.2.5'), base);

  const swapped = [
    { ...b, targetIndex: 0 },
    { ...a, targetIndex: 1 },
  ];
  assert.notEqual(await computeSourceHash(swapped, '1.2.5'), base);
  assert.notEqual(await computeSourceHash([a], '1.2.5'), base);
  assert.notEqual(await computeSourceHash([a, { ...b, sha256: sha('f') }], '1.2.5'), base);
  assert.notEqual(await computeSourceHash([a, { ...b, width: 1000 }], '1.2.5'), base);
  assert.notEqual(await computeSourceHash([a, b], '1.2.6'), base);
});

// ------------------------------------------- the real .mind files (unchanged)

const POC = 'public/targets/targets-poc.mind';
const LEGACY = 'public/targets/targets.mind';

test('summarizeTargets reads the real six-target PoC pack', () => {
  const { version, targets } = readMind(POC);

  assert.equal(version, 2);
  assert.equal(targets.length, 6);
  assert.deepEqual(
    targets.map((target) => `${target.width}x${target.height}`),
    ['1254x1254', '1254x1254', '1254x1254', '1254x1254', '1254x1254', '745x708'],
  );
  // The same numbers tools/inspect-targets.mjs prints.
  assert.equal(targets[0].matchingPoints, 4746);
  assert.equal(targets[0].matchingPointsLargest, 500);
  assert.deepEqual(targets[0].trackingPoints, [42, 22]);
  assert.equal(targets[5].matchingPoints, 2157);
  assert.deepEqual(targets[5].trackingPoints, [28, 22]);
});

test('the two shipped .mind files are byte-for-byte unchanged', () => {
  assert.equal(
    readMind(POC).sha256,
    '2d77e34977b73dd90c648e2139132640d5f2257515e463c9a90d937752a338bc',
  );
  assert.equal(
    readMind(LEGACY).sha256,
    '4dcb1e080a0b81b7e2e23f9be6c9ab7dffceb19aca24d171589f3bfe49939423',
  );
});

test('every target already in production grades as good', () => {
  for (const path of [POC, LEGACY]) {
    readMind(path).targets.forEach((target, index) => {
      assert.equal(gradeTarget(target).grade, 'good', `${path} target ${index}`);
      assert.equal(gradeFeatureCount(target.matchingPoints), 'good');
    });
  }
});

const pocSources = (): CompileSource[] =>
  readMind(POC).targets.map((target, targetIndex) => ({
    targetIndex,
    artworkId: `art-${targetIndex}`,
    artworkName: `Artwork ${targetIndex}`,
    triggerMediaId: `media-${targetIndex}`,
    sha256: sha(String(targetIndex)),
    width: target.width,
    height: target.height,
  }));

test('verification passes when the pack matches its sources', () => {
  assert.deepEqual(verifyCompiledTargets(pocSources(), readMind(POC).targets), []);
});

test('verification catches a wrong target count', () => {
  const problems = verifyCompiledTargets(pocSources().slice(0, 5), readMind(POC).targets);

  assert.match(problems.join('\n'), /6 targets but 5 images/);
});

test('verification catches a target at the wrong index', () => {
  // Swap the last two sources: the 745x708 trigger now claims index 4.
  const sources = pocSources();
  const swapped = [
    ...sources.slice(0, 4),
    { ...sources[5], targetIndex: 4 },
    { ...sources[4], targetIndex: 5 },
  ];
  const problems = verifyCompiledTargets(swapped, readMind(POC).targets);

  assert.equal(problems.length, 2);
  assert.match(problems[0], /Target 4 .*compiled as 1254 x 1254 but the trigger is 745 x 708/);
});

test('verification catches an out-of-order source list and empty targets', () => {
  const sources = pocSources();
  const targets = readMind(POC).targets;

  assert.match(
    verifyCompiledTargets([{ ...sources[0], targetIndex: 3 }, ...sources.slice(1)], targets).join('\n'),
    /out of order/,
  );

  const featureless: CompiledTarget[] = targets.map((target, index) =>
    index === 2 ? { ...target, matchingPoints: 0, matchingScales: 0 } : target,
  );
  assert.match(verifyCompiledTargets(sources, featureless).join('\n'), /Target 2 .*no features/);

  const untrackable = targets.map((target, index) =>
    index === 1 ? { ...target, trackingPoints: [0, 0] } : target,
  );
  assert.match(verifyCompiledTargets(sources, untrackable).join('\n'), /Target 1 .*no points to track/);

  assert.notDeepEqual(verifyCompiledTargets([], []), []);
});

test('summarizeTargets rejects data that is not a target list', () => {
  assert.throws(() => summarizeTargets(undefined));
  assert.throws(() => summarizeTargets([{ targetImage: { width: 1, height: 1 } }]));
  // What MindAR's importData returns for an outdated file.
  assert.deepEqual(summarizeTargets([]), []);
});

test('quality grading bands', () => {
  const target = (matchingPoints: number, tracking: number): CompiledTarget => ({
    width: 1000,
    height: 1000,
    matchingScales: 10,
    matchingPointsLargest: Math.min(500, matchingPoints),
    matchingPoints,
    trackingPoints: [tracking, 10],
  });

  assert.equal(gradeTarget(target(4700, 40)).grade, 'good');
  assert.deepEqual(gradeTarget(target(4700, 40)).reasons, []);
  assert.equal(gradeTarget(target(1200, 40)).grade, 'fair');
  assert.equal(gradeTarget(target(4700, 12)).grade, 'fair');
  assert.equal(gradeTarget(target(300, 40)).grade, 'poor');
  assert.equal(gradeTarget(target(4700, 3)).grade, 'poor');
  assert.equal(gradeTarget(target(300, 3)).reasons.length, 2);

  assert.equal(gradeFeatureCount(null), null);
  assert.equal(gradeFeatureCount(900), 'fair');
  assert.equal(gradeFeatureCount(10), 'poor');
});

// --------------------------------------------------------- items and profile

test('pack items carry the compile order and the size embedded in the file', () => {
  const sources = pocSources();
  const items = buildPackItems(sources, readMind(POC).targets);

  assert.deepEqual(items.map((item) => item.target_index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(items[5], {
    target_index: 5,
    artwork_id: 'art-5',
    trigger_media_id: 'media-5',
    trigger_sha256: sha('5'),
    width: 745,
    height: 708,
    feature_count: 2157,
  });
});

test('pack items are refused for an unverified compile', () => {
  assert.throws(() => buildPackItems(pocSources().slice(0, 3), readMind(POC).targets));
});

test('target pack path is versioned and never a fixed live path', () => {
  assert.equal(targetPackKey('camp-1', 3), 'targets/camp-1/v3/targets.mind');
  assert.notEqual(targetPackKey('camp-1', 3), targetPackKey('camp-1', 4));
  assert.throws(() => targetPackKey('camp-1', 0));
  assert.throws(() => targetPackKey('camp-1', 1.5));
  assert.throws(() => targetPackKey('../x', 1));
});

test('MindAR stays pinned to 1.2.5 in the code and in package.json', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const installed = JSON.parse(readFileSync('node_modules/mind-ar/package.json', 'utf8'));

  assert.equal(MINDAR_COMPILER_VERSION, '1.2.5');
  assert.equal(pkg.dependencies['mind-ar'], '1.2.5');
  assert.equal(installed.version, '1.2.5');
});

test('test profile takes index and size from pack items, not from artwork order', () => {
  const media = (key: string, mode: 'normal' | 'alpha-packed' | null) => ({
    storage_provider: 'supabase',
    bucket: 'ar-media',
    storage_key: key,
    video_mode: mode,
    status: 'active',
  });
  const layer = (artworkId: string, extra: Record<string, unknown>) => ({
    artwork_id: artworkId,
    layer_type: 'VIDEO' as const,
    position_x: 0,
    position_y: 0,
    position_z: 0.01,
    scale: 1,
    rotation_x: 0,
    rotation_y: 0,
    rotation_z: 0,
    fit: 'video' as const,
    loop: true,
    muted: true,
    enabled: true,
    sort_order: 0,
    media: media('media/m1/a.mp4', 'alpha-packed'),
    ...extra,
  });

  const profile = buildPackProfile({
    pack: {
      id: 'pack-1',
      version: 3,
      storage_provider: 'supabase',
      bucket: 'ar-media',
      storage_key: 'targets/c/v3/targets.mind',
    },
    rotateMatchOrder: true,
    // Deliberately not in index order.
    items: [
      { target_index: 1, artwork_id: 'b', width: 745, height: 708, artwork: { id: 'b', name: 'B' } },
      { target_index: 0, artwork_id: 'a', width: 1254, height: 1254, artwork: { id: 'a', name: 'A' } },
    ],
    layers: [
      layer('a', {}),
      layer('a', { enabled: false, media: media('media/m2/off.mp4', 'normal') }),
      layer('b', {
        layer_type: 'MODEL_3D',
        fit: null,
        scale: 0.25,
        rotation_x: 90,
        media: media('media/m3/model.glb', null),
      }),
      layer('b', { media: { ...media('media/m4/old.mp4', 'normal'), status: 'archived' } }),
    ],
    resolveUrl: (asset) => `https://cdn.example/${asset.bucket}/${asset.key}`,
  });

  assert.equal(profile.targetSrc, 'https://cdn.example/ar-media/targets/c/v3/targets.mind');
  assert.equal(profile.rotateMatchOrder, true);
  assert.deepEqual(
    profile.artworks.map((a) => [a.targetIndex, a.id, a.targetWidth, a.targetHeight]),
    [
      [0, 'a', 1254, 1254],
      [1, 'b', 745, 708],
    ],
  );
  assert.deepEqual(profile.artworks[0].layers, [
    {
      type: 'VIDEO',
      src: 'https://cdn.example/ar-media/media/m1/a.mp4',
      videoMode: 'alpha-packed',
      fit: 'video',
      scale: 1,
      position: [0, 0, 0.01],
      loop: true,
      muted: true,
    },
  ]);
  assert.deepEqual(profile.artworks[1].layers, [
    {
      type: 'MODEL_3D',
      src: 'https://cdn.example/ar-media/media/m3/model.glb',
      scale: 0.25,
      position: [0, 0, 0.01],
      rotation: [90, 0, 0],
    },
  ]);
});

// ------------------------------------------- stored-file check (client side)

test('stored pack check: the compiled file passes', async () => {
  const { checkStoredPack } = await import('../src/cms/targetPack.ts');

  assert.equal(
    checkStoredPack({ sha256: sha('a'), fileSize: 5257783 }, { sha256: sha('a'), size: 5257783 }),
    null,
  );
});

test('stored pack check: right size but different contents is rejected', async () => {
  const { checkStoredPack } = await import('../src/cms/targetPack.ts');

  // The case the database cannot see: it compares sizes only.
  const problem = checkStoredPack(
    { sha256: sha('a'), fileSize: 5257783 },
    { sha256: sha('b'), size: 5257783 },
  );

  assert.match(problem ?? '', /right size but different contents/);
});

test('stored pack check: a real file with one byte changed is rejected', async () => {
  const { checkStoredPack } = await import('../src/cms/targetPack.ts');
  const original = readFileSync(POC);
  const tampered = Buffer.from(original);

  tampered[tampered.length >> 1] ^= 0xff;

  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const expected = { sha256: hash(original), fileSize: original.length };

  assert.equal(tampered.length, original.length);
  assert.equal(checkStoredPack(expected, { sha256: hash(original), size: original.length }), null);
  assert.match(
    checkStoredPack(expected, { sha256: hash(tampered), size: tampered.length }) ?? '',
    /different contents/,
  );
});

test('stored pack check: a truncated or padded file is rejected on size', async () => {
  const { checkStoredPack } = await import('../src/cms/targetPack.ts');
  const expected = { sha256: sha('a'), fileSize: 1000 };

  assert.match(checkStoredPack(expected, { sha256: sha('a'), size: 999 }) ?? '', /999 bytes, but 1000 bytes/);
  assert.match(checkStoredPack(expected, { sha256: sha('a'), size: 1001 }) ?? '', /1001 bytes/);
  assert.match(checkStoredPack(expected, { sha256: sha('a'), size: 0 }) ?? '', /0 bytes/);
});

// ------------------------------------------------------------ pack size limit

test('pack size limit is 50 MB and equals the database limit', async () => {
  const { MAX_PACK_BYTES } = await import('../src/cms/targetPack.ts');
  const migration = readFileSync('supabase/migrations/20261014090000_cms_target_packs.sql', 'utf8');
  const inDatabase = /create function public\.cms_pack_max_bytes\(\)[\s\S]*?select (\d+)::bigint/.exec(migration);

  assert.equal(MAX_PACK_BYTES, 50 * 1024 * 1024);
  assert.equal(Number(inDatabase?.[1]), MAX_PACK_BYTES);
});

test('pack size check: the real packs fit, an oversized one is refused with a reason', async () => {
  const { MAX_PACK_BYTES, checkPackSize } = await import('../src/cms/targetPack.ts');

  assert.equal(checkPackSize(readFileSync(POC).length), null);
  assert.equal(checkPackSize(readFileSync(LEGACY).length), null);
  assert.equal(checkPackSize(MAX_PACK_BYTES), null);
  assert.match(checkPackSize(MAX_PACK_BYTES + 1) ?? '', /largest pack that can be stored is 50\.0 MB/);
  assert.match(checkPackSize(120 * 1024 * 1024) ?? '', /compiled pack is 120\.0 MB/);
});
