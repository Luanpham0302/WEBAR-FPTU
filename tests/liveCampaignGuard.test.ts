// Static checks for the H1 fix: an Editor must not change the status of the
// live campaign. The database behaviour itself is tested by
// supabase/tests/live_campaign_guard.test.sql, which needs a Postgres with
// the migrations applied.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const DIR = 'supabase/migrations';
const FIX = `${DIR}/20261017090000_cms_guard_live_campaign.sql`;
const RELEASES = `${DIR}/20261016090000_cms_releases.sql`;
const BEHAVIOUR_TEST = 'supabase/tests/live_campaign_guard.test.sql';

const read = (path: string) => readFileSync(path, 'utf8');
const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

// The body of the last `create ... function public.cms_guard_campaign()`.
function guardBody(sql: string): string {
  const start = sql.lastIndexOf('function public.cms_guard_campaign()');
  assert.ok(start >= 0, 'cms_guard_campaign() is defined');
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(open + 2, close);
}

test('the H1 fix is the last migration that defines cms_guard_campaign()', () => {
  const definers = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => /function public\.cms_guard_campaign\(\)/.test(read(`${DIR}/${f}`)));
  assert.equal(definers.at(-1), '20261017090000_cms_guard_live_campaign.sql');
});

test('the H1 migration runs in one transaction', () => {
  const sql = squash(withoutComments(read(FIX)));
  assert.ok(sql.startsWith('begin;'));
  assert.ok(sql.endsWith('commit;'));
});

test('the H1 migration changes the guard function only', () => {
  const sql = withoutComments(read(FIX)).toLowerCase();
  for (const forbidden of [
    /\bcreate\s+policy\b/, /\bdrop\s+policy\b/, /\balter\s+policy\b/,
    /\bgrant\s/, /\brevoke\s/, /\balter\s+table\b/, /\bcreate\s+table\b/,
    /\bdrop\s/, /\binsert\s+into\b/, /\bdelete\s+from\b/, /\bupdate\s+public\./,
    /\bsecurity\s+definer\b/,
    /function\s+public\.cms_publish_release\b/,
    /function\s+public\.cms_get_live_manifest\b/,
    /function\s+public\.cms_guard_release\b/,
  ]) {
    assert.doesNotMatch(sql, forbidden);
  }
  const created = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)/g)]
    .map((m) => m[1]);
  assert.deepEqual(created, ['public.cms_guard_campaign']);
});

test('the guard keeps the Phase 2C.2 publish-only rule verbatim', () => {
  const rule = squash(`
    if current_user <> (
       select pg_catalog.pg_get_userbyid(proowner)
       from pg_catalog.pg_proc
       where oid = 'public.cms_publish_release(uuid)'::regprocedure
    ) then
      raise exception 'The live release can only change through cms_publish_release.'
        using errcode = '42501';
    end if;`);
  assert.ok(squash(guardBody(read(RELEASES))).includes(rule), 'rule found in Phase 2C.2');
  assert.ok(squash(guardBody(read(FIX))).includes(rule), 'rule kept by the fix');
});

test('the guard makes the live campaign status an Admin change', () => {
  const body = squash(withoutComments(guardBody(read(FIX))));
  assert.match(body, /tg_op = 'UPDATE' and old\.live_release_id is not null and new\.status is distinct from old\.status/);
  assert.match(body, /if not public\.cms_has_role\('admin'\) then raise exception 'Only an Admin can change the status of the live campaign\.' using errcode = '42501';/);
  // Operators without a signed-in user (SQL editor, service role) pass.
  assert.match(body, /if auth\.uid\(\) is not null then if not public\.cms_has_role\('admin'\)/);
  // The live pointer can only land on an active campaign.
  assert.match(body, /new\.live_release_id is not null and new\.status is distinct from 'active'/);
});

test('the guard stays SECURITY INVOKER with an empty search_path', () => {
  const fix = withoutComments(read(FIX));
  const start = fix.indexOf('function public.cms_guard_campaign()');
  const header = fix.slice(start, fix.indexOf('$$', start));
  assert.match(header, /returns trigger/);
  assert.match(header, /set search_path = ''/);
  assert.doesNotMatch(header.toLowerCase(), /security definer/);
  // The postflight refuses a SECURITY DEFINER guard on the database too.
  assert.match(fix, /if v_fn\.prosecdef then/);
});

test('the behaviour test can never commit what it writes', () => {
  const sql = squash(withoutComments(read(BEHAVIOUR_TEST))).toLowerCase();
  assert.ok(sql.startsWith('begin;'));
  assert.ok(sql.endsWith('rollback;'));
  assert.doesNotMatch(sql, /\bcommit\b/);
  for (const check of [
    'fail viewer: archived a campaign',
    'fail h1: an editor archived the live campaign',
    'fail editor: could not edit the live campaign',
    'fail editor: could not archive a non-live campaign',
    'fail admin: could not archive the live campaign',
    'fail: publish r2 then rollback to r1 did not end with r1 live',
  ]) {
    assert.ok(sql.includes(check), check);
  }
});
