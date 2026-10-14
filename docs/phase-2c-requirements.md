# Phase 2C requirements carried over from Phase 2B

Phase 2B builds and stores target packs. It does not publish. This file records what Phase 2B deliberately leaves open, so Phase 2C does not assume more than was built.

## 1. A trusted backend must verify pack contents before publish

**The gap.** `target_packs.status = 'verified'` means only this:

- the pack was reserved through `cms_reserve_target_pack()`;
- its `target_pack_items` are complete and matched the campaign's Ready artworks when it was reserved;
- a file exists in storage at the reserved path;
- storage reports a size for that file equal to the reserved size.

Postgres cannot read a stored file. The database does **not** check that the file is a MindAR target file, how many targets it holds, or its SHA-256. `target_packs.sha256` is the value reported by the browser that compiled the pack.

The only content check today is `checkStoredPack()` in `src/cms/targetPack.ts`. It runs in the browser of the person who compiled the pack. It catches accidents. It is not a control against an Editor who calls the API directly: that person can reserve a pack, upload any file of the declared size, and have it marked verified.

**Requirement.** Publishing must be refused unless a trusted backend has verified the stored bytes. "Trusted" means code that runs outside any browser, with its own credentials, such as a Supabase Edge Function or the company server. It must:

1. Download the object at `target_packs.bucket` / `storage_key` itself. It must not accept bytes or a hash from the client.
2. Compute the SHA-256 of those bytes and compare it with `target_packs.sha256`.
3. Parse the file as a MindAR 1.2.5 target file: msgpack, format version 2, a `dataList` array.
4. Check that `dataList.length` equals `target_packs.target_count`.
5. Check that the embedded width and height of each target equal the `width` and `height` of the `target_pack_items` row with the same `target_index`.
6. Record the result where a client cannot write it. Suggested: columns `content_verified_at`, `content_verified_sha256` and `content_verified_by` on `target_packs`, written only by that backend, never through a policy for `authenticated`.

The publish function must then require `content_verified_at is not null` in the same transaction that moves the live pointer.

`tools/inspect-targets.mjs` and `summarizeTargets()` / `verifyCompiledTargets()` in `src/cms/targetPack.ts` already implement steps 3 to 5 and can be reused by the backend.

## 2. Invariants Phase 2C can rely on

These are enforced by the database after `20261014090000_cms_target_packs.sql`:

- **Every release points at a verified pack of its own campaign.** `cms_guard_release_pack` checks both on insert, on any change of `target_pack_id` or `campaign_id`, and whenever a release becomes `published`, which includes a rollback that republishes a superseded release. It does not rely on the Phase 2A foreign key or immutability trigger, although both also exist. A pack referenced by any release, in any status including `superseded`, cannot be retired. Rollback to a superseded release therefore never meets a retired or failed pack.
- **Packs and their items never change and are never deleted.** A release can store a pack id and trust the mapping forever.
- **The file of a non-failed pack cannot be overwritten or deleted through the API.**
- **A pack is the whole campaign.** Its items were exactly the Ready artworks of the campaign at reservation time. A manifest must still be built from `target_pack_items`, never from the current artwork list, because artworks keep changing after a pack is built.

Phase 2C code that creates a release must read the pack status inside its transaction. The trigger already takes a share lock on the pack row, so a concurrent retire cannot slip between the check and the insert.

## 3. Rules Phase 2C still has to add

- **Editors can insert preview releases directly** (Phase 2A policy `releases_insert`). The pack must be verified, but the manifest is whatever the client sends. Release creation should move behind a function that builds the manifest on the server from `target_pack_items` and `artwork_layers`, as pack creation did in Phase 2B.
- **Only an Admin may publish or roll back**, through one function that moves `campaigns.live_release_id`, marks the previous release superseded and writes the audit row in one transaction. Phase 2A still lets an Admin move the pointer with a direct update; that should be removed when the function exists.
- **Pre-existing data.** `supabase/manual/05_pre_target_packs.sql` query 5b lists releases whose pack is not verified. It must return no rows before Phase 2C relies on the invariant above.

## 4. Known limits that are not Phase 2C blockers

- A pack can be at most 50 MB (`cms_pack_max_bytes()` and `MAX_PACK_BYTES`), the Supabase Storage upload limit of a default project and the maximum on the Free plan. Packs are uploaded in one request. Supabase recommends resumable uploads above 6 MB for reliability; that is not implemented, so a large pack on a poor connection can fail and has to be saved again.

- Pack files are public by URL. The path contains a random campaign id, but a pack includes low-resolution greyscale copies of its trigger images.
- Duplicate triggers are detected by file hash. The same picture saved again as a different file is not detected.
- The restrictive storage policies bind the `authenticated` role. The migration refuses to run if any policy gives the anonymous role a storage write, but it cannot stop one being added later. Keep `05_pre_target_packs.sql` query 6 as a periodic check.
