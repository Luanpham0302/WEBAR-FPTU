// Static checks for the M1 fix: the ar-media bucket and its upload policies.
// The database behaviour is tested by supabase/tests/storage_hardening.test.sql.
// The bucket allowlist is enforced by the Storage API; test it with uploads.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AR_MEDIA_ALLOWED_MIME_TYPES,
  AR_MEDIA_MAX_BYTES,
  MEDIA_FORMATS,
} from '../src/cms/mediaRules.ts';
import { mediaKey, targetPackKey } from '../src/cms/storageKeys.ts';
import { MAX_PACK_BYTES } from '../src/cms/targetPack.ts';

const MIGRATION = 'supabase/migrations/20261017120000_cms_storage_hardening.sql';
const BEHAVIOUR_TEST = 'supabase/tests/storage_hardening.test.sql';

const sql = readFileSync(MIGRATION, 'utf8');
const code = sql.replace(/--[^\n]*/g, '');
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

const UUID = '0b9f6c1e-2f43-4c8e-9d0a-6f1f8b7a5c11';
const SHA = 'c'.repeat(64);

// The two patterns of cms_ar_media_path_kind(), as JavaScript regexps.
function pathPattern(prefix: 'media' | 'targets'): RegExp {
  const match = code.match(new RegExp(`when p_name ~ '(\\^${prefix}/[^']+)'`));
  assert.ok(match, `${prefix} pattern found`);
  return new RegExp(match[1]);
}

test('the M1 migration runs in one transaction', () => {
  const body = squash(code);
  assert.ok(body.startsWith('begin;'));
  assert.ok(body.endsWith('commit;'));
});

test('the bucket allowlist and size limit equal the client rules', () => {
  const list = code.match(/allowed_mime_types = array\[([^\]]+)\]/);
  assert.ok(list);
  const types = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(types, [...AR_MEDIA_ALLOWED_MIME_TYPES].sort());
  assert.ok(!types.includes('text/html') && !types.includes('image/svg+xml'));
  // .mind packs are uploaded as application/octet-stream.
  assert.ok(types.includes('application/octet-stream'));

  assert.match(code, /set file_size_limit = 52428800,/);
  assert.equal(AR_MEDIA_MAX_BYTES, 52428800);
  assert.ok(AR_MEDIA_MAX_BYTES >= MAX_PACK_BYTES, 'a full-size target pack still fits');
});

test('the migration changes only the ar-media bucket and never a stored object', () => {
  const updates = [...code.matchAll(/update storage\.buckets[\s\S]*?;/g)].map((m) => m[0]);
  assert.equal(updates.length, 1);
  assert.match(updates[0], /where id = 'ar-media';$/);
  assert.doesNotMatch(code, /insert into storage\.buckets/i);
  assert.doesNotMatch(code, /(delete from|update) storage\.objects/i);
  assert.doesNotMatch(code, /drop policy (if exists )?cms_(target_objects_insert|pack_objects_\w+|scanner_\w+|source_\w+)/);
});

test('media paths: the server rule accepts exactly the client formats', () => {
  const media = pathPattern('media');
  const extensions = Object.values(MEDIA_FORMATS).flatMap((formats) =>
    formats.map((format) => format.extension),
  );
  for (const extension of extensions) {
    assert.match(mediaKey(UUID, SHA, extension), media, extension);
  }
  const listed = code.match(/\\\.\(([a-z0-9|]+)\)\$'/);
  assert.ok(listed);
  assert.deepEqual(listed[1].split('|').sort(), [...extensions].sort());

  for (const name of [
    `media/${UUID}/${SHA}.html`, `media/${UUID}/${SHA}.svg`, `media/${UUID}/${SHA}.mkv`,
    `media/${UUID}/${SHA}.mov`, `media/${UUID}/${SHA}.MP4`, `media/${UUID}/${SHA}.mp4.html`,
    `media/${UUID}/x.mp4`, `media/${UUID.toUpperCase()}/${SHA}.mp4`, 'media/x.mp4',
  ]) {
    assert.doesNotMatch(name, media, name);
  }
});

test('target pack paths: the server rule accepts what the CMS reserves', () => {
  const targets = pathPattern('targets');
  assert.match(targetPackKey(UUID, 1), targets);
  assert.match(targetPackKey(UUID, 12), targets);
  assert.doesNotMatch(`targets/${UUID}/v0/targets.mind`, targets);
  assert.doesNotMatch(`targets/${UUID}/v1/targets.html`, targets);
});

test('the media insert policy is replaced and two restrictive guards are added', () => {
  const body = squash(code);
  assert.match(body, /create policy cms_media_objects_insert on storage\.objects for insert to authenticated with check \( bucket_id = 'ar-media' and public\.cms_ar_media_path_kind\(name\) = 'media' and \(select public\.cms_has_role\('editor'\)\) \);/);
  for (const [name, command] of [
    ['cms_ar_media_objects_path_guard', 'insert'],
    ['cms_ar_media_objects_rename_guard', 'update'],
  ]) {
    assert.match(body, new RegExp(`create policy ${name} on storage\\.objects as restrictive for ${command} to public`));
  }
  assert.match(body, /bucket_id is distinct from 'ar-media' or public\.cms_ar_media_path_kind\(name\) is not null/);
  assert.match(body, /create or replace function public\.cms_ar_media_path_kind\(p_name text\) returns text language sql immutable set search_path = ''/);
});

test('the rename guard checks the current name (USING) and the new name (WITH CHECK)', () => {
  const guard = "\\( bucket_id is distinct from 'ar-media' or public\\.cms_ar_media_path_kind\\(name\\) is not null \\)";
  assert.match(
    squash(code),
    new RegExp(`create policy cms_ar_media_objects_rename_guard on storage\\.objects as restrictive for update to public using ${guard} with check ${guard};`),
  );
  assert.doesNotMatch(code, /using \(true\)/i);
});

test('the migration adds no permissive UPDATE policy', () => {
  const policies = [...squash(code).matchAll(/create policy (\w+) on storage\.objects (as restrictive )?for (\w+)/g)];
  for (const [, name, restrictive, command] of policies) {
    if (command === 'update' || command === 'all') {
      assert.ok(restrictive, `${name} must be restrictive`);
    }
  }
  assert.deepEqual(
    policies.map(([, name]) => name).sort(),
    ['cms_ar_media_objects_path_guard', 'cms_ar_media_objects_rename_guard', 'cms_media_objects_insert'],
  );
});

test('postflight compares every other bucket in both directions', () => {
  const body = squash(code);
  assert.match(body, /create temp table cms_m1_other_buckets on commit drop as select to_jsonb\(b\) as bucket from storage\.buckets b where b\.id <> 'ar-media';/);
  assert.match(body, /\(select to_jsonb\(b\) as bucket from storage\.buckets b where b\.id <> 'ar-media' except select bucket from cms_m1_other_buckets\) union all \(select bucket from cms_m1_other_buckets except select to_jsonb\(b\) from storage\.buckets b where b\.id <> 'ar-media'\)/);
});

test('the behaviour test can never commit what it writes', () => {
  const body = squash(readFileSync(BEHAVIOUR_TEST, 'utf8').replace(/--[^\n]*/g, '')).toLowerCase();
  assert.ok(body.startsWith('begin;'));
  assert.ok(body.endsWith('rollback;'));
  assert.doesNotMatch(body, /\bcommit\b/);
  for (const check of [
    'fail editor: stored %',
    'fail viewer: stored media',
    'fail anon: stored media',
    'fail bucket: ar-media allows html or svg',
    'fail rename guard: renamed media to .html',
    'fail rename guard: updated an off-pattern object',
    'fail target pack: its stored file was updated',
    'fail policies: permissive update policies can reach ar-media',
  ]) {
    assert.ok(body.includes(check), check);
  }
});
