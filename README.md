# Web AR Shirt

A web AR app built with React, Vite, Three.js, and MindAR. It recognises printed trigger images through the device camera and plays a video or 3D model on top of each one, all in a single camera session.

## Features

- Auto-start camera scan on load (pixel anime game UI).
- Several trigger images in one MindAR `.mind` file; the user moves from one to the next without reloading.
- Video layers (normal or alpha-packed transparent video) and GLB 3D model layers.
- Media loads only when its trigger is recognised. A broken media file shows a hint and never stops the scanner.
- Sound on/off control for videos that have a soundtrack.
- Admin CMS (`/admin`): campaigns, artworks, media library and scanner settings, backed by Supabase. Loaded as a separate chunk.
- Local HTTPS dev server for camera access.

## Stack

- React 19, Vite 7, TypeScript
- MindAR 1.2.5, Three.js 0.150.1
- Supabase (Auth, Storage, Postgres with row level security)

## Requirements

- Node.js 20+ recommended
- npm
- `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (never commit this file)
- A device with a camera for real AR testing

## Install and run

```bash
npm install
npm run dev      # HTTPS dev server, e.g. https://localhost:5173
npm run build    # production build into dist/
npm run preview  # preview the production build
npm test         # unit tests for the CMS helpers (Node 24, no framework)
```

For phone testing, use the LAN URL from Vite. Camera access requires HTTPS or localhost.

## URLs and profiles

A profile is one target file plus the content for each trigger in it. The profile is chosen from the URL.

| URL | Profile | Target file |
| --- | --- | --- |
| `/` | `legacy` (default, production) | `public/targets/targets.mind` |
| `/?profile=poc` | `poc` (technical PoC) | `public/targets/targets-poc.mind` |
| `/admin` | Admin page | - |

Profiles are defined in `src/config/arProfiles.ts`. The default is `legacy`; changing it is a deliberate one-line change in `selectProfile()`.

### Legacy profile

Three shirt targets, each with one alpha-packed video. Settings live in `src/ar/arAssets.ts`. Videos published from `/admin` replace these three videos (legacy profile only).

### PoC profile

Six triggers, six videos and one GLB in one camera session.

| targetIndex | Artwork | Content |
| --- | --- | --- |
| 0 | Artwork A | Video 01, alpha-packed |
| 1 | Artwork B | Video 02, alpha-packed |
| 2 | Artwork C | Video 03, alpha-packed |
| 3 | Artwork D | Video 04, normal |
| 4 | Artwork E | Video 05, normal + GLB model |
| 5 | Coc AI | Video 06, normal |

Video 04, Video 05 and the GLB in `public/poc/media/` are development placeholders. Replace the files, or change the paths in `src/config/arProfiles.ts`, to use real assets.

## Admin CMS (Phase 2A)

`/admin` has six sections: Dashboard, Campaigns, Artworks, Media Library, Target Packs and Scanner Settings. Campaigns, artworks and media are working copies; the scanner still runs the built-in profiles until target packs and releases exist.

- **Database.** SQL lives in `supabase/migrations/` and is applied by hand, in file-name order. Files 1-3 only add new objects. File 4 (`cms_hardening`) restricts the existing `ar_content` table and `ar-assets` bucket to CMS roles; create the first Admin and deploy the frontend before applying it. `supabase/manual/` holds the audit and preview queries, the first-Admin script and a rollback for file 4.
- **Roles.** `viewer` reads, `editor` edits working copies, `admin` also publishes. A user without a row in `user_roles` has no CMS access. Row level security enforces this; the UI only hides buttons.
- **Storage.** All file access goes through the `StorageAdapter` in `src/cms/storage/`. Stored files are never overwritten: every path contains the SHA-256 of the file.

| Bucket | Access | Path |
| --- | --- | --- |
| `ar-media` | public | `media/{media-id}/{sha256}.{ext}` and `targets/{campaign-id}/v{n}/targets.mind` |
| `ar-sources` | private | `triggers/{campaign-id}/{artwork-id}/{sha256}.{ext}` |
| `ar-assets` | public, existing | `scanner/{asset-key}/{sha256}.{ext}` |

- **Scanner Settings.** An upload goes to a new file and only changes the preview. The live scanner changes when Publish writes the new URL to `ar_content`.
- **Release manifest.** `src/cms/manifest.ts` defines the immutable snapshot a release stores, and converts it to the runtime `ARProfile`. The scanner does not use it yet.

## Target packs (Phase 2B)

A target pack is one compiled MindAR `.mind` file for a campaign, built in the Admin under Target Packs. Building a pack never changes what visitors see: nothing is live until a release is published (Phase 2C).

1. Each artwork gets a private trigger image in the Artwork editor. The upload checks format, resolution, aspect ratio and duplicates.
2. Target Packs lists every Ready artwork in compile order. The row number is the `targetIndex`.
3. Compile downloads each private trigger, checks its SHA-256, and compiles with the same MindAR 1.2.5 build the scanner runs.
4. The result is read back with MindAR's own parser and checked target by target: count, index and pixel size. Tracking quality is graded per target.
5. Save reserves the next version in the database, together with the full `targetIndex` mapping in `target_pack_items`, then uploads to `ar-media/targets/{campaign-id}/v{n}/targets.mind`, downloads it again and compares the hash. Only then is the pack marked verified.
6. Test opens a signed-in camera screen for that pack. It is separate from the public scanner.

Packs are numbered and never overwritten. A pack whose upload did not finish is marked failed or shown as interrupted and can never be used. `target_pack_items` is the only source of target indexes after a compile.

A pack always contains every Ready artwork of its campaign; the database refuses a pack that leaves one out or includes one that is not Ready. To leave an artwork out, set it to Draft.

**What "verified" means.** The database marks a pack verified when it was reserved through the validated function, its mapping is complete, and a file is stored at the reserved path with the reserved size. The database cannot read the file, so it does not check the `.mind` contents or the SHA-256; that comparison runs in the compiling browser. Verified is therefore not an approval to publish. See `docs/phase-2c-requirements.md`.

A pack can be at most 50 MB, which is the Supabase Storage upload limit of a default project and the maximum on the Free plan. The PoC pack with six targets is 5 MB. The limit lives in `cms_pack_max_bytes()` in the database and `MAX_PACK_BYTES` in `src/cms/targetPack.ts`; raise both together if the project limit is raised.

Packs cannot be written directly through the API. Three database functions are the only way in: reserve, verify and set status. Pack rows and items are a permanent record, so a version number and its storage path are never reused. Apply `supabase/migrations/20261014090000_cms_target_packs.sql` by hand, with `supabase/manual/05_pre_target_packs.sql` before and `06_post_target_packs.sql` after; `07_rollback_target_packs.sql` undoes it.

The dev-only `tools/compile-targets.html` still exists for the built-in PoC profile and is unchanged.

## Layers

Each artwork has one or more layers:

- `VIDEO` with `videoMode: 'normal'` or `'alpha-packed'` (colour in the left half of the frame, alpha in the right half).
- `MODEL_3D`: a GLB file, anchored to the trigger image.

Position, scale and rotation are in trigger-image units: 1 unit is the trigger's width, and +z points out of the image toward the viewer.

Memory: the current artwork plus `MAX_PAUSED_ARTWORKS` older ones (default 1) stay loaded; the rest are freed. Set it to 0 in `src/config/arProfiles.ts` if a device runs short of memory.

## Compiling trigger images

`targetIndex` is the position of the image in the list that was compiled, so the order must never change by accident.

1. Put the source images in `tools/trigger-sources/`. They are compile-time files and are deliberately outside `public/`, so they are not shipped.
2. List them, in targetIndex order, in the `TRIGGERS` array in `tools/compile-targets.html`.
3. Run `npm run dev` and open `https://localhost:5173/tools/compile-targets.html`, then press Compile.
4. Save the download as `public/targets/targets-poc.mind`.
5. Check the result:

```bash
node tools/inspect-targets.mjs public/targets/targets-poc.mind
```

It prints the target count, each target's size and its feature counts. Put the sizes into the profile (`targetWidth` / `targetHeight`).

Trigger images should have dense, high-contrast, non-repeating detail and should not share elements (borders, logos, lettering) with each other. MindAR works in greyscale, so different colours alone do not make two images distinct.

## Project structure

```text
public/
  animations/        Legacy videos and the loading animation
  poc/media/         PoC placeholder videos and GLB
  targets/           MindAR .mind target files
  ui/                Scanner overlay images
src/
  ar/                MindAR viewer, artwork manager, video and model layers
  config/            Profiles and tracking settings
  admin/             Admin shell and sections (lazy chunk)
  cms/               CMS services, storage adapter, release manifest
  lib/               Supabase client and content service
  pages/             Scan page and admin entry point
  styles/            Global CSS
supabase/
  migrations/        CMS schema, security and storage SQL
  manual/            Audit query and first-Admin script
tests/               Unit tests
tools/
  compile-targets.html   Dev-only target compiler page
  inspect-targets.mjs    Prints the contents of a .mind file
  trigger-sources/       Source images for the PoC triggers
```

## Notes

- Do not commit `node_modules/`, `dist/` or `.env.local`.
- If the camera does not open, check browser permissions and that the app runs on HTTPS.
