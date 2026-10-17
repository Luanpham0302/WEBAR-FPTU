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
