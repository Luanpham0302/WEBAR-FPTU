# Phase 2C.2 — Releases, private preview and site-wide publishing

## Status

This branch contains Phase 2C.2 source code and SQL. **No migration or Edge
Function has been deployed by the GitHub changes alone.** Phase 2C.1 was
already applied and tested in the Staging Supabase project.

All application testing must use Supabase **Staging** project
`bkshtgufuhlkytsmproo`. Do not deploy to Production or merge into `main`
without separate authorization and a fresh security review.

## Architecture

1. `cms-verify-pack` Edge Function authenticates the caller with
   `auth.getUser(jwt)` and checks Editor/Admin role on the server.
2. It downloads the reserved target pack from Supabase Storage **itself**;
   hashes the stored bytes with SHA-256; parses MindAR format v2; validates
   the target count and each embedded width/height against frozen
   `target_pack_items`. It records a private attestation in
   `cms_trusted_pack_checks` using a server-only service role.
3. `cms_create_release(pack_id,notes)` is Editor/Admin only; it requires the
   attestation and a verified MindAR 1.2.5 pack, then generates the immutable
   manifest from `target_pack_items` plus enabled working `artwork_layers`.
   Clients cannot insert arbitrary Release JSON directly.
4. `cms_get_preview_manifest(token)` is CMS-member-only (Viewer+).
   `/?preview=<token>` opens the *same* scanner using the frozen snapshot.
5. `cms_publish_release(id)` is Admin only; uses a serialized DB
   transaction to supersede the prior site-wide release and move the live
   pointer. Publishing a superseded release is a rollback.
6. `cms_get_live_manifest()` is anonymous-safe and returns **only** the
   manifest selected by the live pointer; `/` uses it. With no live CMS
   release or an unavailable release RPC, the legacy scanner remains.
   `/?profile=poc` stays isolated from CMS calls.

The function can verify a file's structure and its declared hash, but
MindAR v2 bytes do not independently prove what compiler executable created
the file; the compiler version is also enforced using pack metadata.

## Deployment steps (STAGING ONLY)

1. Run the **entire** migration
   `supabase/migrations/20261016090000_cms_releases.sql`
   in the Staging Supabase SQL Editor. It is transactional and has its own
   prerequisite and privilege postflight checks. Do not run it twice.
2. Install/login to the Supabase CLI on your own machine as needed.
   From this branch's root, deploy the verifier to Staging:
   `npx supabase functions deploy cms-verify-pack --project-ref bkshtgufuhlkytsmproo`
   The function validates the user JWT inside the handler; `supabase/config.toml`
   sets `verify_jwt = false` **only** to allow unauthenticated OPTIONS
   preflight. A request without a valid user session is rejected by code.
3. Configure Vite `.env.local` locally for the Staging project, using the
   publishable/anon key, **never** `service_role` or `sb_secret_...`.
   Restart Vite after editing env. Run `npm ci`, `npm run build`, `npm test`.
4. Sign in to `/admin`; open **Releases** and select the test campaign.
   Click **Verify on server** for the already stored `Target pack v1`.
5. Click **Create preview release**. Open **Preview** while logged into the
   same browser origin. Confirm the video appears over the trigger image.
6. With an Admin session only, click **Publish**. Test the scanner at `/`
   (Staging-local host only). Create a second release after a working-copy
   edit to test preview and rolling back to the earlier superseded version.
7. Confirm `/?profile=poc` still works independently of the CMS.

## Phase 2C.3 — live campaign status fix (H1, STAGING ONLY)

Before this fix an Editor could archive the live campaign through the REST
API; `cms_get_live_manifest()` then returned nothing and the scanner fell
back to the legacy content without any publish or rollback.
`supabase/migrations/20261017090000_cms_guard_live_campaign.sql` replaces
only the `cms_guard_campaign()` trigger function: changing the status of a
campaign that has a live release now needs an Admin, and the live pointer can
only be set on an active campaign. No policy, grant or row is changed.

1. Run the whole migration in the Staging SQL Editor. It is transactional,
   checks its prerequisites and postflight, and is safe to re-run. A WARNING
   means a live campaign is already archived; review it with an Admin.
2. Run `supabase/tests/live_campaign_guard.test.sql` in the same editor. It
   creates its own users, campaigns and releases, publishes and rolls back,
   and always ends in `ROLLBACK`. Expect `ALL 25 CHECKS PASSED`.

## Phase 2C.4 — ar-media storage hardening (M1, STAGING ONLY)

`supabase/migrations/20261017120000_cms_storage_hardening.sql` limits the
public `ar-media` bucket to 50 MB and to `video/mp4`, `video/webm`,
`model/gltf-binary`, `image/png`, `image/jpeg`, `image/webp` and
`application/octet-stream` (target packs). Media uploads must use the path
`media/{uuid}/{sha256}.{mp4|webm|glb|png|jpg|webp}`; target pack uploads keep
their reserved-path rule. Two RESTRICTIVE policies refuse any other name in
`ar-media`. Stored files, `ar-assets` and `ar-sources` are not changed.

1. Run the whole migration in the Staging SQL Editor. NOTICEs list existing
   objects the new rules would refuse; they are reported, never changed.
2. Run `supabase/tests/storage_hardening.test.sql`. It inserts metadata rows
   only, uploads no file and always ends in `ROLLBACK`. Expect
   `ALL 28 CHECKS PASSED`. A temporary test policy locks `storage.objects`
   for the moment the script runs, so run it when nobody is uploading.
3. The MIME allowlist and size limit are enforced by the Storage API, not by
   SQL: test them with real uploads from `/admin` (see the M1 report).

Storage checks the type an upload declares, not its bytes. A media file is
always served with an allowed type, but its contents are not verified.

## Phase 2C.4 — HTTP security headers (M2, STAGING FIRST)

`npm run build` writes `dist/_headers` (Netlify) from
`src/security/securityHeaders.ts`. No Netlify build setting changes.

- The CSP allows exactly the build's own Supabase project
  (`VITE_SUPABASE_URL`), Google Fonts, and `blob:` for MindAR workers, GLB
  textures and CMS file previews. No `unsafe-inline`, `unsafe-eval`, `data:`
  or wildcard.
- A known site must use its own project: the build fails if the Staging site
  (`fptu-webar-staging`) is built against `rnqfnotdditgwtmyjdbs`, or the
  Production site against `bkshtgufuhlkytsmproo`. Netlify sets `SITE_ID` and
  `SITE_NAME`; `WEBAR_ENV=staging|production` can also be set explicitly.
- `CSP_MODE` (Netlify environment variable, build time):
  - unset or `report-only` (default): `Content-Security-Policy:
    frame-ancestors 'none'` is enforced, the full policy is sent as
    `Content-Security-Policy-Report-Only`. Violations appear in the browser
    console only.
  - `enforce`: the full policy is enforced, with `frame-ancestors 'none'` and
    `upgrade-insecure-requests`. Set it only after the Staging tests pass;
    nothing switches to it by itself.
- Always: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(self), microphone=(), …`,
  `Cross-Origin-Opener-Policy: same-origin`. HSTS is Netlify's own; no COEP.
- Expected on every page, harmless: a `wasm-eval` report (Long.js tries a
  tiny WebAssembly module and falls back to JavaScript) and a
  `style-src-elem` report on the Scanner (MindAR's built-in CSS, which the
  app's own CSS replaces).

## Phase 2C.4 — live asset protection (M3, STAGING FIRST)

`supabase/migrations/20261017180000_cms_live_asset_protection.sql`:

- No object named in any release manifest (preview, published or
  superseded) can be deleted, moved or changed through the API, not even by
  an Admin. Media files used only by working layers, and failed pack files,
  can still be cleaned up.
- A media row named by a release cannot be deleted; archive it instead.
- `ar-assets` accepts only PNG, JPEG, WebP, MP4 and WebM, at most 50 MB, at
  `scanner/{asset}/{sha256}.{ext}`. Scanner Settings applies the same rules
  (no SVG). Existing files, including the legacy `live/` files, are not
  changed.
- A scanner asset that `ar_content` points at cannot be deleted.
- The service role (Dashboard, SQL editor) bypasses these guards: delete
  release files only after checking `public.cms_is_released_object(bucket, name)`.

1. Run the migration in one session (psql, or the whole file at once in the
   SQL Editor). Its NOTICEs print the previous `ar-assets` settings, confirm
   the live release's files are protected, and count legacy files the new
   rules would refuse (they are not changed).
2. Run `supabase/tests/live_asset_protection.test.sql` with psql in one
   session. It always ends in `ROLLBACK`. Expect `ALL 29 CHECKS PASSED`.
   Then re-run `storage_hardening.test.sql` (28) and
   `live_campaign_guard.test.sql` (25).

The public scanner now fails closed on any problem with the published
manifest; only a failure to reach Supabase, or no published release, falls
back to the legacy scanner (`src/cms/scannerSource.ts`).

## Expected role access

- Viewer: list releases and open private previews, no verification/build/publish.
- Editor: verify stored target packs, create release snapshots, private preview.
  Edits campaigns, but cannot change the status of the live campaign.
- Admin: everything Editor can do plus publish and rollback, and archive or
  reactivate the live campaign.
- Anonymous: read only the currently published manifest; cannot read
  unpublished releases, preview tokens or the trusted attestation table.

## Important boundaries

- Never publish based solely on `target_packs.status = 'verified'`:
  the separate trusted attestation is mandatory in the database functions.
- The trusted verifier and SQL have not been end-to-end tested against a real
  deployed Staging Edge Function yet. Validate there before any rollout.
- Production has not been changed, nor has this branch been merged.
- Keep media objects referenced by releases available; deleting released
  media directly from Storage can still break old manifests and must be
  handled by a later retention/cleanup policy.
- Existing npm audit warnings (including critical/high vulnerabilities)
  need dependency review before Production deployment.
