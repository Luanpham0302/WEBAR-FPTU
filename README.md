# Web AR Shirt

A web AR app built with React, Vite, Three.js, and MindAR. It recognises printed trigger images through the device camera and plays a video or 3D model on top of each one, all in a single camera session.

## Features

- Auto-start camera scan on load (pixel anime game UI).
- Several trigger images in one MindAR `.mind` file; the user moves from one to the next without reloading.
- Video layers (normal or alpha-packed transparent video) and GLB 3D model layers.
- Media loads only when its trigger is recognised. A broken media file shows a hint and never stops the scanner.
- Sound on/off control for videos that have a soundtrack.
- Admin page (`/admin`) for scanner UI assets and the legacy videos, backed by Supabase.
- Local HTTPS dev server for camera access.

## Stack

- React 19, Vite 7, TypeScript
- MindAR 1.2.5, Three.js 0.150.1
- Supabase (Auth, Storage, one config table)

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
  lib/               Supabase client and content service
  pages/             Scan page and admin page
  styles/            Global CSS
tools/
  compile-targets.html   Dev-only target compiler page
  inspect-targets.mjs    Prints the contents of a .mind file
  trigger-sources/       Source images for the PoC triggers
```

## Notes

- Do not commit `node_modules/`, `dist/` or `.env.local`.
- If the camera does not open, check browser permissions and that the app runs on HTTPS.
