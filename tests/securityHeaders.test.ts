import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'vite';
import {
  SUPABASE_PROJECTS,
  cspMode,
  deployEnvironment,
  renderHeadersFile,
  securityHeaders,
  securityHeadersPlugin,
  supabaseOrigin,
} from '../src/security/securityHeaders.ts';

const STAGING = 'https://bkshtgufuhlkytsmproo.supabase.co';
const PRODUCTION = 'https://rnqfnotdditgwtmyjdbs.supabase.co';
const STAGING_SITE_ID = '64d6cdbb-d111-47b6-a887-5d032cb31ed2';
const PRODUCTION_SITE_ID = '788f3f7e-2b22-4e9a-aa7e-6921400b027f';

const header = (result: ReturnType<typeof securityHeaders>, name: string) =>
  result.headers.find(([key]) => key === name)?.[1];

// directive name -> sources
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

test('only https://<ref>.supabase.co is accepted as the Supabase URL', () => {
  assert.equal(supabaseOrigin(STAGING), STAGING);
  assert.equal(supabaseOrigin(`${PRODUCTION}/`), PRODUCTION);

  for (const bad of [
    undefined,
    '',
    'bkshtgufuhlkytsmproo.supabase.co',
    'http://bkshtgufuhlkytsmproo.supabase.co',
    'https://bkshtgufuhlkytsmproo.supabase.co:8443',
    'https://bkshtgufuhlkytsmproo.supabase.co/rest/v1',
    'https://bkshtgufuhlkytsmproo.supabase.co/?x=1',
    'https://user:pass@bkshtgufuhlkytsmproo.supabase.co',
    'https://bkshtgufuhlkytsmproo.supabase.co.evil.example',
    'https://evil.example/bkshtgufuhlkytsmproo.supabase.co',
    'https://short.supabase.co',
    'https://*.supabase.co',
    'https://localhost:54321',
  ]) {
    assert.throws(() => supabaseOrigin(bad), /VITE_SUPABASE_URL/, String(bad));
  }
});

test('each environment gets its own Supabase origin and never the other one', () => {
  const staging = securityHeaders({ VITE_SUPABASE_URL: STAGING, SITE_NAME: 'fptu-webar-staging' });
  assert.equal(staging.environment, 'staging');
  assert.match(header(staging, 'Content-Security-Policy-Report-Only')!, /bkshtgufuhlkytsmproo/);
  assert.doesNotMatch(renderHeadersFile(staging), /rnqfnotdditgwtmyjdbs/);

  const production = securityHeaders({ VITE_SUPABASE_URL: PRODUCTION, SITE_ID: PRODUCTION_SITE_ID });
  assert.equal(production.environment, 'production');
  assert.match(header(production, 'Content-Security-Policy-Report-Only')!, /rnqfnotdditgwtmyjdbs/);
  assert.doesNotMatch(renderHeadersFile(production), /bkshtgufuhlkytsmproo/);

  // A known site built against the other project fails the build.
  for (const env of [
    { VITE_SUPABASE_URL: PRODUCTION, SITE_NAME: 'fptu-webar-staging' },
    { VITE_SUPABASE_URL: PRODUCTION, SITE_ID: STAGING_SITE_ID },
    { VITE_SUPABASE_URL: STAGING, SITE_NAME: 'inspiring-bublanina-eeb615' },
    { VITE_SUPABASE_URL: STAGING, SITE_ID: PRODUCTION_SITE_ID },
    { VITE_SUPABASE_URL: STAGING, WEBAR_ENV: 'production' },
    { VITE_SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', WEBAR_ENV: 'staging' },
  ]) {
    assert.throws(() => securityHeaders(env), /build, but VITE_SUPABASE_URL is the project/, JSON.stringify(env));
  }

  assert.deepEqual(SUPABASE_PROJECTS, { staging: 'bkshtgufuhlkytsmproo', production: 'rnqfnotdditgwtmyjdbs' });
});

test('the environment is taken only from WEBAR_ENV or a known Netlify site, and must agree', () => {
  assert.equal(deployEnvironment({}), null);
  assert.equal(deployEnvironment({ SITE_NAME: 'some-other-site', SITE_ID: 'x' }), null);
  assert.equal(deployEnvironment({ WEBAR_ENV: 'staging', SITE_ID: STAGING_SITE_ID }), 'staging');
  assert.throws(() => deployEnvironment({ WEBAR_ENV: 'prod' }), /WEBAR_ENV/);
  assert.throws(
    () => deployEnvironment({ SITE_ID: STAGING_SITE_ID, SITE_NAME: 'inspiring-bublanina-eeb615' }),
    /ambiguous/,
  );
  assert.throws(() => deployEnvironment({ WEBAR_ENV: 'staging', SITE_ID: PRODUCTION_SITE_ID }), /ambiguous/);

  // A local build (no site) may use either project; the policy follows the URL.
  assert.equal(securityHeaders({ VITE_SUPABASE_URL: PRODUCTION }).supabase, PRODUCTION);
});

test('CSP_MODE defaults to report-only, never switches by itself, and refuses typos', () => {
  assert.equal(cspMode(undefined), 'report-only');
  assert.equal(cspMode(''), 'report-only');
  assert.equal(cspMode('report-only'), 'report-only');
  assert.equal(cspMode('enforce'), 'enforce');
  for (const bad of ['enforced', 'ENFORCE', 'true', 'off']) {
    assert.throws(() => cspMode(bad), /CSP_MODE/, bad);
  }
  assert.equal(securityHeaders({ VITE_SUPABASE_URL: STAGING }).mode, 'report-only');
});

test('report-only: enforce only frame-ancestors, report the full policy', () => {
  const result = securityHeaders({ VITE_SUPABASE_URL: STAGING, CSP_MODE: 'report-only' });

  assert.equal(header(result, 'Content-Security-Policy'), "frame-ancestors 'none'");
  const report = directives(header(result, 'Content-Security-Policy-Report-Only')!);
  // Ignored by browsers in a Report-Only policy, so left out.
  assert.ok(!report.has('frame-ancestors'));
  assert.ok(!report.has('upgrade-insecure-requests'));
  assert.deepEqual(report.get('script-src'), ["'self'"]);
  assert.deepEqual(report.get('worker-src'), ["'self'", 'blob:']);
  assert.equal(result.headers.filter(([name]) => name === 'Content-Security-Policy').length, 1);
});

test('enforce: one full enforced policy, no Report-Only header', () => {
  const result = securityHeaders({ VITE_SUPABASE_URL: STAGING, CSP_MODE: 'enforce' });

  assert.equal(header(result, 'Content-Security-Policy-Report-Only'), undefined);
  const policy = directives(header(result, 'Content-Security-Policy')!);
  assert.deepEqual(policy.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(policy.get('upgrade-insecure-requests'), []);

  const reportOnly = directives(
    header(securityHeaders({ VITE_SUPABASE_URL: STAGING }), 'Content-Security-Policy-Report-Only')!,
  );
  for (const [name, sources] of reportOnly) {
    assert.deepEqual(policy.get(name), sources, `${name} is the same in both modes`);
  }
});

test('the policy allows exactly what the app needs and nothing broad', () => {
  const policy = directives(
    header(securityHeaders({ VITE_SUPABASE_URL: STAGING, CSP_MODE: 'enforce' }), 'Content-Security-Policy')!,
  );

  assert.deepEqual(Object.fromEntries(policy), {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com'],
    'img-src': ["'self'", 'blob:', STAGING],
    'media-src': ["'self'", 'blob:', STAGING],
    'connect-src': ["'self'", 'blob:', STAGING],
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'upgrade-insecure-requests': [],
  });

  const sources = [...policy.values()].flat();
  for (const source of sources) {
    assert.ok(!source.includes('*'), `no wildcard: ${source}`);
    assert.ok(!/unsafe|data:|http:|filesystem:|mediastream:/.test(source), `not allowed: ${source}`);
  }
});

test('the other headers: clickjacking, sniffing, referrer, camera only, no HSTS, no COEP', () => {
  const result = securityHeaders({ VITE_SUPABASE_URL: STAGING });
  const names = result.headers.map(([name]) => name.toLowerCase());

  assert.equal(header(result, 'X-Frame-Options'), 'DENY');
  assert.equal(header(result, 'X-Content-Type-Options'), 'nosniff');
  assert.equal(header(result, 'Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.equal(header(result, 'Cross-Origin-Opener-Policy'), 'same-origin');

  const permissions = header(result, 'Permissions-Policy')!.split(', ');
  assert.ok(permissions.includes('camera=(self)'));
  assert.ok(permissions.includes('microphone=()'));
  assert.ok(permissions.every((entry) => entry === 'camera=(self)' || entry.endsWith('=()')));

  assert.ok(!names.includes('strict-transport-security'), 'HSTS is left to Netlify');
  assert.ok(!names.includes('cross-origin-embedder-policy'));
  assert.ok(!names.includes('x-xss-protection'));
});

test('no secret reaches the headers file', () => {
  const env = {
    VITE_SUPABASE_URL: STAGING,
    VITE_SUPABASE_ANON_KEY: 'sb_publishable_TESTKEYTESTKEYTESTKEY',
    SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.SECRETSIG',
    NETLIFY_AUTH_TOKEN: 'nfp_TESTTOKENTESTTOKEN',
    DATABASE_URL: 'postgresql://postgres:hunter2@db.example:5432/postgres',
  };
  const file = renderHeadersFile(securityHeaders(env));

  for (const value of Object.values(env).slice(1)) {
    assert.ok(!file.includes(value));
  }
  assert.doesNotMatch(file, /sb_publishable_|sb_secret_|eyJ|nfp_|hunter2|postgres(ql)?:/);
});

test('the headers file is in Netlify format and applies to every path', () => {
  const file = renderHeadersFile(securityHeaders({ VITE_SUPABASE_URL: STAGING, SITE_NAME: 'fptu-webar-staging' }));
  const lines = file.trimEnd().split('\n');

  assert.ok(lines[0].startsWith('#') && lines[1].startsWith('#'));
  assert.match(lines[1], /environment: staging; CSP_MODE: report-only; Supabase: https:\/\/bkshtgufuhlkytsmproo\.supabase\.co/);
  assert.equal(lines[2], '/*');
  for (const line of lines.slice(3)) {
    assert.match(line, /^ {2}[A-Za-z-]+: \S/);
  }
});

test('index.html has no inline script, so script-src stays self', () => {
  const html = readFileSync('index.html', 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];

  assert.ok(scripts.length > 0);
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /\bsrc=/);
    assert.equal(body.trim(), '');
  }
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  assert.ok(!existsSync('public/_headers'), 'headers are generated, not kept in public/');
});

async function buildSample(files: Record<string, string>, env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'webar-headers-'));
  try {
    writeFileSync(join(root, 'index.html'), '<!doctype html><script type="module" src="/main.js"></script>');
    writeFileSync(join(root, 'main.js'), 'console.log(1);');
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, name), content);
    }
    await build({
      root,
      configFile: false,
      envDir: root,
      logLevel: 'silent',
      plugins: [securityHeadersPlugin({ env })],
      build: { outDir: join(root, 'dist'), emptyOutDir: true },
    });
    const headers = join(root, 'dist', '_headers');
    return existsSync(headers) ? readFileSync(headers, 'utf8') : null;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('vite build writes dist/_headers from the URL in the .env file', async () => {
  const file = await buildSample(
    { '.env.local': `VITE_SUPABASE_URL=${STAGING}\nVITE_SUPABASE_ANON_KEY=sb_publishable_FILEKEY123\n` },
    { SITE_NAME: 'fptu-webar-staging' },
  );

  assert.equal(
    file,
    renderHeadersFile(securityHeaders({ VITE_SUPABASE_URL: STAGING, SITE_NAME: 'fptu-webar-staging' })),
  );
  assert.ok(!file.includes('FILEKEY123'));
});

test('vite build fails instead of writing wrong headers', async () => {
  await assert.rejects(
    buildSample({ '.env.local': `VITE_SUPABASE_URL=${PRODUCTION}\n` }, { SITE_NAME: 'fptu-webar-staging' }),
    /staging build, but VITE_SUPABASE_URL is the project rnqfnotdditgwtmyjdbs/,
  );
  await assert.rejects(
    buildSample({ '.env.local': `VITE_SUPABASE_URL=${STAGING}\n` }, { CSP_MODE: 'enforced' }),
    /CSP_MODE/,
  );
  // On Netlify a missing URL fails the build...
  await assert.rejects(buildSample({}, { NETLIFY: 'true' }), /VITE_SUPABASE_URL/);
  // ...an invalid one fails everywhere...
  await assert.rejects(buildSample({ '.env.local': 'VITE_SUPABASE_URL=http://example.com\n' }, {}), /VITE_SUPABASE_URL/);
  await assert.rejects(
    (async () => securityHeadersPlugin({ env: {}, publicHeadersFileExists: true }).configResolved({ env: { VITE_SUPABASE_URL: STAGING } }))(),
    /public\/_headers exists/,
  );
});

test('off Netlify (CI), a build without VITE_SUPABASE_URL succeeds and writes no _headers', async () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    assert.equal(await buildSample({}, {}), null);
  } finally {
    console.warn = warn;
  }
  assert.match(warnings.join('\n'), /dist\/_headers was not written/);
});
