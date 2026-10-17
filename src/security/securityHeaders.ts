// HTTP security headers for the Netlify site, written to dist/_headers by the
// Vite build. Pure: no imports, so it also runs under `node --test`.
//
// The policy is built from VITE_SUPABASE_URL, so each build allows exactly
// its own Supabase project. When the build can tell which site it is for
// (WEBAR_ENV, or the SITE_ID / SITE_NAME that Netlify sets), the project must
// be that site's project: a Staging build can never ship a Production origin,
// nor the other way round.
//
// CSP_MODE=report-only (the default) enforces only frame-ancestors and
// reports everything else. CSP_MODE=enforce enforces the whole policy. The
// mode never changes by itself.
//
// Every source below is needed by the app as built (see docs, M2):
//   blob:  MindAR starts its tracking and compiler workers from Blob URLs;
//          GLTFLoader reads embedded GLB textures through Blob URLs (fetch on
//          Chrome, <img> on Safari); the CMS previews and measures local files
//          and decodes trigger images through Blob URLs.
//   fonts  index.html loads Google Fonts.
// Not needed, so not allowed: 'unsafe-inline', 'unsafe-eval',
// 'wasm-unsafe-eval', data:, any wildcard. HSTS is left to Netlify, which
// already sends max-age=31536000; includeSubDomains; preload. No COEP: the app
// needs no cross-origin isolation, and COEP would block Supabase media.

export type DeployEnvironment = 'staging' | 'production';
export type CspMode = 'report-only' | 'enforce';

export const SUPABASE_PROJECTS: Readonly<Record<DeployEnvironment, string>> = {
  staging: 'bkshtgufuhlkytsmproo',
  production: 'rnqfnotdditgwtmyjdbs',
};

// Netlify sites. SITE_ID never changes; SITE_NAME changes if the site is renamed.
const NETLIFY_SITE_IDS: Readonly<Record<string, DeployEnvironment>> = {
  '64d6cdbb-d111-47b6-a887-5d032cb31ed2': 'staging',
  '788f3f7e-2b22-4e9a-aa7e-6921400b027f': 'production',
};

const NETLIFY_SITE_NAMES: Readonly<Record<string, DeployEnvironment>> = {
  'fptu-webar-staging': 'staging',
  'inspiring-bublanina-eeb615': 'production',
};

const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com';
const GOOGLE_FONTS_FILES = 'https://fonts.gstatic.com';

type Env = Readonly<Record<string, string | undefined>>;

// https://<20-character project ref>.supabase.co, nothing else.
export function supabaseOrigin(value: string | undefined): string {
  let url: URL;

  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error('VITE_SUPABASE_URL is missing or not a URL.');
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)
  ) {
    throw new Error(
      `VITE_SUPABASE_URL must be https://<project-ref>.supabase.co, got ${url.origin}.`,
    );
  }

  return url.origin;
}

export const projectRefOf = (origin: string) => new URL(origin).hostname.split('.')[0];

// The environment this build is for, or null when nothing identifies it
// (a local build, or another site).
export function deployEnvironment(env: Env): DeployEnvironment | null {
  const claims: [string, DeployEnvironment][] = [];

  if (env.WEBAR_ENV) {
    if (env.WEBAR_ENV !== 'staging' && env.WEBAR_ENV !== 'production') {
      throw new Error(`WEBAR_ENV must be "staging" or "production", got "${env.WEBAR_ENV}".`);
    }
    claims.push(['WEBAR_ENV', env.WEBAR_ENV]);
  }
  if (env.SITE_ID && NETLIFY_SITE_IDS[env.SITE_ID]) {
    claims.push(['SITE_ID', NETLIFY_SITE_IDS[env.SITE_ID]]);
  }
  if (env.SITE_NAME && NETLIFY_SITE_NAMES[env.SITE_NAME]) {
    claims.push(['SITE_NAME', NETLIFY_SITE_NAMES[env.SITE_NAME]]);
  }

  const environments = new Set(claims.map(([, environment]) => environment));

  if (environments.size > 1) {
    throw new Error(
      `The build environment is ambiguous: ${claims.map(([from, environment]) => `${from}=${environment}`).join(', ')}.`,
    );
  }

  return claims.length > 0 ? claims[0][1] : null;
}

export function cspMode(value: string | undefined): CspMode {
  if (value === undefined || value === '') {
    return 'report-only';
  }
  if (value !== 'report-only' && value !== 'enforce') {
    throw new Error(`CSP_MODE must be "report-only" or "enforce", got "${value}".`);
  }
  return value;
}

// Directives shared by both modes. frame-ancestors and
// upgrade-insecure-requests are added by contentSecurityPolicy(): browsers
// ignore both in a Report-Only policy.
export function policyDirectives(supabase: string): [string, ...string[]][] {
  return [
    ['default-src', "'self'"],
    ['script-src', "'self'"],
    ['style-src', "'self'", GOOGLE_FONTS_CSS],
    ['font-src', "'self'", GOOGLE_FONTS_FILES],
    ['img-src', "'self'", 'blob:', supabase],
    ['media-src', "'self'", 'blob:', supabase],
    ['connect-src', "'self'", 'blob:', supabase],
    ['worker-src', "'self'", 'blob:'],
    // Workers on browsers without worker-src (older WebViews) fall back here.
    ['child-src', "'self'", 'blob:'],
    ['frame-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
  ];
}

const serialize = (directives: [string, ...string[]][]) =>
  directives.map((parts) => parts.join(' ')).join('; ');

export type SecurityHeaders = {
  environment: DeployEnvironment | null;
  mode: CspMode;
  supabase: string;
  headers: [string, string][];
};

export function securityHeaders(env: Env): SecurityHeaders {
  const supabase = supabaseOrigin(env.VITE_SUPABASE_URL);
  const environment = deployEnvironment(env);
  const mode = cspMode(env.CSP_MODE);

  if (environment && projectRefOf(supabase) !== SUPABASE_PROJECTS[environment]) {
    throw new Error(
      `This is a ${environment} build, but VITE_SUPABASE_URL is the project ${projectRefOf(supabase)}, ` +
        `not ${SUPABASE_PROJECTS[environment]}.`,
    );
  }

  const directives = policyDirectives(supabase);
  const csp: [string, string][] =
    mode === 'enforce'
      ? [[
          'Content-Security-Policy',
          serialize([...directives, ['frame-ancestors', "'none'"], ['upgrade-insecure-requests']]),
        ]]
      : [
          ['Content-Security-Policy', "frame-ancestors 'none'"],
          ['Content-Security-Policy-Report-Only', serialize(directives)],
        ];

  return {
    environment,
    mode,
    supabase,
    headers: [
      ...csp,
      ['X-Frame-Options', 'DENY'],
      ['X-Content-Type-Options', 'nosniff'],
      ['Referrer-Policy', 'strict-origin-when-cross-origin'],
      [
        'Permissions-Policy',
        'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), xr-spatial-tracking=()',
      ],
      // The app opens no popup and has no OAuth flow, so nothing depends on
      // window.opener across origins.
      ['Cross-Origin-Opener-Policy', 'same-origin'],
    ],
  };
}

// Netlify _headers format.
export function renderHeadersFile(result: SecurityHeaders): string {
  return [
    '# Generated by the Vite build (src/security/securityHeaders.ts). Do not edit.',
    `# environment: ${result.environment ?? 'not identified'}; CSP_MODE: ${result.mode}; Supabase: ${result.supabase}`,
    '/*',
    ...result.headers.map(([name, value]) => `  ${name}: ${value}`),
    '',
  ].join('\n');
}

// Minimal shapes of the Vite hooks used, so this file needs no Vite import.
type ResolvedConfigLike = { env: Env };
type EmitContext = {
  emitFile(file: { type: 'asset'; fileName: string; source: string }): string;
};

// Vite plugin: dist/_headers on every `vite build`. Build-time variables
// (CSP_MODE, WEBAR_ENV, SITE_ID, SITE_NAME, NETLIFY) come from `env`;
// VITE_SUPABASE_URL comes from Vite's own env loading (.env files or the
// environment), the same value the app is built with.
//
// Any problem fails the build, with one exception: off Netlify (CI, a local
// build without .env.local) a MISSING VITE_SUPABASE_URL only skips the file,
// because nothing built there is deployed. On Netlify (NETLIFY=true) it fails.
export function securityHeadersPlugin(options: { env: Env; publicHeadersFileExists?: boolean }) {
  let file: string | null = null;

  return {
    name: 'webar-security-headers',
    apply: 'build' as const,
    configResolved(config: ResolvedConfigLike) {
      if (options.publicHeadersFileExists) {
        throw new Error('public/_headers exists. Security headers are generated; remove that file.');
      }
      const url = config.env.VITE_SUPABASE_URL ?? options.env.VITE_SUPABASE_URL;

      if (!url && options.env.NETLIFY !== 'true') {
        console.warn('[webar-security-headers] VITE_SUPABASE_URL is not set: dist/_headers was not written.');
        return;
      }
      file = renderHeadersFile(securityHeaders({ ...options.env, VITE_SUPABASE_URL: url }));
    },
    generateBundle(this: EmitContext) {
      if (file !== null) {
        this.emitFile({ type: 'asset', fileName: '_headers', source: file });
      }
    },
  };
}
