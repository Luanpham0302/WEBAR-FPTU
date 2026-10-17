// Static checks for the M3 fix: files of releases and of the published
// ar_content stay in place, and ar-assets accepts only safe scanner assets.
// The database behaviour is tested by supabase/tests/live_asset_protection.test.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AR_ASSETS_ALLOWED_MIME_TYPES,
  AR_ASSETS_MAX_BYTES,
  MEDIA_FORMATS,
  SCANNER_ASSET_KINDS,
  scannerAssetFormatOf,
} from '../src/cms/mediaRules.ts';
import { scannerKey } from '../src/cms/storageKeys.ts';

const MIGRATION = 'supabase/migrations/20261017180000_cms_live_asset_protection.sql';
const BEHAVIOUR_TEST = 'supabase/tests/live_asset_protection.test.sql';

const sql = readFileSync(MIGRATION, 'utf8');
const code = sql.replace(/--[^\n]*/g, '');
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const SHA = 'c'.repeat(64);

function scannerPattern(): RegExp {
  const match = code.match(/when p_name ~ '(\^scanner\/[^']+)'/);
  assert.ok(match, 'scanner path pattern found');
  return new RegExp(match[1]);
}

test('the M3 migration runs in one transaction and uses no temp table', () => {
  const body = squash(code);
  assert.ok(body.startsWith('begin;'));
  assert.ok(body.endsWith('commit;'));
  assert.doesNotMatch(code, /create temp(orary)? table/i);
});

test('it changes no stored data: no object, release, media row or ar_content value', () => {
  assert.doesNotMatch(code, /(delete from|update|insert into) storage\.objects/i);
  assert.doesNotMatch(code, /(delete from|update|insert into) public\.(releases|media|ar_content|campaigns|target_packs)\b/i);
  const updates = [...code.matchAll(/update storage\.buckets[\s\S]*?;/g)].map((m) => m[0]);
  assert.equal(updates.length, 1);
  assert.match(updates[0], /where id = 'ar-assets';$/);
  assert.doesNotMatch(code, /drop policy (if exists )?cms_(media|source|target|pack|ar_media|scanner)_/);
});

test('ar-assets allowlist and size limit equal the client rules; no SVG, HTML, GIF or MOV', () => {
  const list = code.match(/allowed_mime_types = array\[([^\]]+)\]/);
  assert.ok(list);
  const types = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(types, [...AR_ASSETS_ALLOWED_MIME_TYPES].sort());
  for (const forbidden of ['image/svg+xml', 'text/html', 'image/gif', 'video/quicktime', 'application/octet-stream']) {
    assert.ok(!types.includes(forbidden), forbidden);
  }
  assert.match(code, /set file_size_limit = 52428800,/);
  assert.equal(AR_ASSETS_MAX_BYTES, 52428800);
});

test('scanner paths: the server rule accepts exactly what Scanner Settings writes', () => {
  const pattern = scannerPattern();

  for (const [key, kind] of Object.entries(SCANNER_ASSET_KINDS)) {
    for (const format of MEDIA_FORMATS[kind]) {
      assert.match(scannerKey(key, SHA, format.extension), pattern, `${key}.${format.extension}`);
    }
  }
  for (const name of [
    `scanner/scannerBorder/${SHA}.svg`, `scanner/scannerBorder/${SHA}.html`,
    `scanner/scannerBorder/${SHA}.gif`, `scanner/scannerBorder/${SHA}.mov`,
    `scanner/scannerBorder/${SHA}.PNG`, `scanner/scannerBorder/${SHA}.png.html`,
    `scanner/scannerBorder/x/${SHA}.png`, `scanner/scanner-border/${SHA}.png`,
    `scanner/${SHA}.png`, `live/${SHA}.png`, 'scanner/scannerBorder/short.png',
  ]) {
    assert.doesNotMatch(name, pattern, name);
  }
});

test('Scanner Settings refuses SVG, GIF, MOV and the wrong kind for a field', () => {
  const file = (name: string, type: string, size = 1024) => ({ name, type, size });

  const image = scannerAssetFormatOf('scannerBorder', file('border.png', 'image/png'));
  assert.ok('format' in image && image.format.mimeType === 'image/png');
  const video = scannerAssetFormatOf('loadingAnimation', file('loading.webm', ''));
  assert.ok('format' in video && video.format.mimeType === 'video/webm');

  for (const [key, name, type] of [
    ['scannerBorder', 'logo.svg', 'image/svg+xml'],
    ['scannerTitle', 'title.gif', 'image/gif'],
    ['scannerFrame', 'frame.png', 'image/svg+xml'],
    ['loadingAnimation', 'clip.mov', 'video/quicktime'],
    ['animation01', 'frame.png', 'image/png'],
    ['scannerBottom', 'clip.mp4', 'video/mp4'],
    ['scannerBorder', 'page.html', 'text/html'],
  ] as const) {
    assert.ok('error' in scannerAssetFormatOf(key, file(name, type)), `${key} ${name}`);
  }
  assert.ok('error' in scannerAssetFormatOf('animation02', file('big.mp4', 'video/mp4', AR_ASSETS_MAX_BYTES + 1)));
});

test('released files and live scanner assets are protected by RESTRICTIVE policies', () => {
  const body = squash(code);
  for (const [name, command] of [
    ['cms_released_objects_protect', 'delete'],
    ['cms_released_objects_update_guard', 'update'],
    ['cms_live_scanner_assets_protect', 'delete'],
    ['cms_ar_assets_path_guard', 'insert'],
    ['cms_ar_assets_rename_guard', 'update'],
  ]) {
    assert.match(body, new RegExp(`create policy ${name} on storage\\.objects as restrictive for ${command} to public`), name);
  }
  // Every policy the migration creates is restrictive: it can only take
  // permission away.
  const created = [...body.matchAll(/create policy (\w+) on storage\.objects (as restrictive )?/g)];
  assert.equal(created.length, 5);
  assert.ok(created.every(([, , restrictive]) => restrictive));

  // Every release status counts, including superseded (rollback) and preview.
  const released = body.match(/create or replace function public\.cms_is_released_object[\s\S]*?\$\$;/);
  assert.ok(released);
  assert.doesNotMatch(released[0], /status/);
  assert.match(released[0], /'layers'/);
  assert.match(released[0], /'targetPack'/);
  assert.match(released[0], /security definer set search_path = ''/);
});

test('a media row named by a release cannot be deleted', () => {
  const body = squash(code);
  assert.match(body, /create trigger cms_guard_media_delete before delete on public\.media for each row execute function public\.cms_guard_media_delete\(\);/);
  assert.match(body, /revoke all on function public\.cms_guard_media_delete\(\) from public, anon, authenticated;/);
});

test('the behaviour test can never commit what it writes', () => {
  const body = squash(readFileSync(BEHAVIOUR_TEST, 'utf8').replace(/--[^\n]*/g, '')).toLowerCase();
  assert.ok(body.startsWith('begin;'));
  assert.ok(body.endsWith('rollback;'));
  assert.doesNotMatch(body, /\bcommit\b/);
  // It never touches the published ar_content row or a published release.
  assert.doesNotMatch(body, /(update|delete from) public\.ar_content/);
  assert.doesNotMatch(body, /'published'\s*,/);
  for (const check of [
    'fail released: admin deleted %',
    'fail scanner: admin deleted an asset ar_content uses',
    'fail media: admin deleted a media row a release names',
    'fail editor: stored ar-assets/%',
    'fail update guard: moved a released file',
    'fail live: % file(s) of the live release are unprotected',
  ]) {
    assert.ok(body.includes(check), check);
  }
});
