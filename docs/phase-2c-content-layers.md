# Phase 2C.1 — Content Layers Editor

## What is implemented
- Under /admin → Artworks → Edit an artwork → Content layers, Editor/Admin can add, edit, order, enable/disable and delete content layers.
- VIDEO layers select an active video, fit, loop, and muted; MODEL_3D layers select an active GLB and X/Y/Z rotation.
- Both support finite Scale 0.05–10, Position -5–5, order >= 0, and 3D rotation -360–360.
- Viewer has read-only access; server-side RLS and database constraints/triggers still enforce permissions and validation.
- Existing Target Packs → Test can preview saved working layers (not a public release).

## Staging-only verification
1. Switch to branch phase-2c-content-layers and configure local Vite for the staging Supabase project.
2. Run npm ci, npm run build, and npm test in the repository root.
3. Sign in at /admin as Editor; upload MP4/GLB in Media Library; open an Artwork and add/edit/delete layers.
4. Verify edits persist after reload. Confirm bad scale/position/rotation are rejected.
5. Sign in as Viewer and confirm only read-only layer details appear.
6. Use a verified Target Pack in Target Packs → Test to preview the AR overlay.

## Important limits
- Content Layers changes are a working copy and are not published automatically.
- The public scanner still uses its previous profile. Release Preview, trusted server-side .mind verification, and Publish/Rollback remain for Phase 2C.
- Phase 2C.1 SQL was already applied on Staging; do not run it on Production.
- Never expose Supabase service-role keys through VITE_ environment variables.
