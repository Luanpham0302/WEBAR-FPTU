-- Phase 2A, file 1 of 4: CMS tables, constraints and indexes.
--
-- Does not touch ar_content, the ar-assets bucket or any existing policy.
-- Status-like columns are text + CHECK rather than Postgres enums, so a new
-- value is a one-line constraint change instead of an enum migration.

begin;

-- ---------------------------------------------------------------- campaigns
create table public.campaigns (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(btrim(name)) > 0),
  slug               text not null unique
                       check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 64),
  description        text not null default '',
  status             text not null default 'active'
                       check (status in ('active', 'archived')),
  -- Runtime settings copied into every release manifest.
  rotate_match_order boolean not null default true,
  tracking           jsonb not null default '{}'::jsonb
                       check (jsonb_typeof(tracking) = 'object'),
  -- The live pointer. Its foreign key is added after releases exists.
  live_release_id    uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id) on delete set null,
  updated_by         uuid references auth.users (id) on delete set null
);

-- -------------------------------------------------------------------- media
-- One row per stored file. The file columns never change after insert (see
-- the guard trigger in file 2); replacing a file means a new row.
create table public.media (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(btrim(name)) > 0),
  type             text not null
                     check (type in ('VIDEO', 'MODEL_3D', 'IMAGE', 'TRIGGER')),
  storage_provider text not null default 'supabase',
  bucket           text not null,
  storage_key      text not null,
  sha256           text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type        text not null,
  file_size        bigint not null check (file_size > 0),
  width            integer check (width > 0),
  height           integer check (height > 0),
  duration         double precision check (duration >= 0),
  video_mode       text check (video_mode in ('normal', 'alpha-packed')),
  status           text not null default 'active'
                     check (status in ('active', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_by       uuid references auth.users (id) on delete set null,
  unique (storage_provider, bucket, storage_key),
  -- video_mode is set for videos and only for videos.
  check ((type = 'VIDEO') = (video_mode is not null)),
  -- A trigger image is useless to the compiler without its pixel size.
  check (type <> 'TRIGGER' or (width is not null and height is not null))
);

create index media_type_created_idx on public.media (type, created_at desc);
create index media_sha256_idx on public.media (sha256);

-- ----------------------------------------------------------------- artworks
create table public.artworks (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references public.campaigns (id) on delete restrict,
  name             text not null check (length(btrim(name)) > 0),
  description      text not null default '',
  category         text not null default '',
  -- The trigger source image and the facts recorded when it was uploaded.
  trigger_media_id uuid references public.media (id) on delete restrict,
  trigger_width    integer check (trigger_width > 0),
  trigger_height   integer check (trigger_height > 0),
  trigger_sha256   text check (trigger_sha256 ~ '^[0-9a-f]{64}$'),
  -- draft: not in the next build. ready: in the next build. "Live" is not a
  -- status here; it is derived from the live release of the campaign.
  status           text not null default 'draft'
                     check (status in ('draft', 'ready', 'archived')),
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_by       uuid references auth.users (id) on delete set null,
  -- The four trigger columns are set together or not at all.
  check (
    (trigger_media_id is null and trigger_width is null
      and trigger_height is null and trigger_sha256 is null)
    or
    (trigger_media_id is not null and trigger_width is not null
      and trigger_height is not null and trigger_sha256 is not null)
  ),
  check (status <> 'ready' or trigger_media_id is not null)
);

create index artworks_campaign_sort_idx on public.artworks (campaign_id, sort_order, created_at);
create index artworks_trigger_media_idx on public.artworks (trigger_media_id);

-- ----------------------------------------------------------- artwork_layers
-- Columns mirror what the current runtime reads (src/ar/types.ts): one
-- uniform scale, rotation in degrees (models only today), fit for videos.
create table public.artwork_layers (
  id          uuid primary key default gen_random_uuid(),
  artwork_id  uuid not null references public.artworks (id) on delete cascade,
  media_id    uuid not null references public.media (id) on delete restrict,
  layer_type  text not null check (layer_type in ('VIDEO', 'MODEL_3D')),
  position_x  double precision not null default 0,
  position_y  double precision not null default 0,
  position_z  double precision not null default 0,
  scale       double precision not null default 1 check (scale > 0),
  rotation_x  double precision not null default 0,
  rotation_y  double precision not null default 0,
  rotation_z  double precision not null default 0,
  fit         text check (fit in ('target', 'video')),
  loop        boolean not null default true,
  muted       boolean not null default true,
  enabled     boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete set null,
  updated_by  uuid references auth.users (id) on delete set null,
  check ((layer_type = 'VIDEO') = (fit is not null))
);

create index artwork_layers_artwork_sort_idx on public.artwork_layers (artwork_id, sort_order);
create index artwork_layers_media_idx on public.artwork_layers (media_id);

-- ------------------------------------------------------------- target_packs
-- One compiled .mind file. Written once; only status changes afterwards.
create table public.target_packs (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references public.campaigns (id) on delete restrict,
  version          integer not null check (version > 0),
  storage_provider text not null default 'supabase',
  bucket           text not null,
  storage_key      text not null,
  sha256           text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  file_size        bigint not null check (file_size > 0),
  target_count     integer not null check (target_count > 0),
  -- Hash of the ordered trigger hashes: detects "nothing changed, reuse".
  source_hash      text not null,
  -- Exact MindAR version that compiled the file, e.g. '1.2.5'.
  compiler_version text not null check (compiler_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  status           text not null default 'uploaded'
                     check (status in ('uploaded', 'verified', 'failed', 'retired')),
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  unique (campaign_id, version),
  unique (storage_provider, bucket, storage_key),
  -- Lets releases prove their pack belongs to the same campaign.
  unique (id, campaign_id)
);

create index target_packs_source_hash_idx on public.target_packs (campaign_id, source_hash);

-- -------------------------------------------------------- target_pack_items
-- The authoritative targetIndex mapping for a pack. Insert-only: manifests
-- are built from these rows, never from artwork sort order.
create table public.target_pack_items (
  pack_id          uuid not null references public.target_packs (id) on delete restrict,
  target_index     integer not null check (target_index >= 0),
  artwork_id       uuid not null references public.artworks (id) on delete restrict,
  trigger_media_id uuid not null references public.media (id) on delete restrict,
  trigger_sha256   text not null check (trigger_sha256 ~ '^[0-9a-f]{64}$'),
  -- Pixel size as embedded in the .mind file (targetWidth / targetHeight).
  width            integer not null check (width > 0),
  height           integer not null check (height > 0),
  feature_count    integer check (feature_count >= 0),
  primary key (pack_id, target_index),
  unique (pack_id, artwork_id)
);

create index target_pack_items_artwork_idx on public.target_pack_items (artwork_id);
create index target_pack_items_media_idx on public.target_pack_items (trigger_media_id);

-- ----------------------------------------------------------------- releases
-- An immutable runtime snapshot. `manifest` is everything the scanner needs.
create table public.releases (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references public.campaigns (id) on delete restrict,
  version        integer not null check (version > 0),
  target_pack_id uuid not null,
  manifest       jsonb not null
                   check (jsonb_typeof(manifest) = 'object' and manifest ? 'schemaVersion'),
  preview_token  uuid not null default gen_random_uuid() unique,
  status         text not null default 'preview'
                   check (status in ('preview', 'published', 'superseded')),
  notes          text not null default '',
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users (id) on delete set null,
  published_at   timestamptz,
  published_by   uuid references auth.users (id) on delete set null,
  unique (campaign_id, version),
  unique (id, campaign_id),
  foreign key (target_pack_id, campaign_id)
    references public.target_packs (id, campaign_id) on delete restrict,
  check ((status = 'preview') = (published_at is null))
);

create index releases_target_pack_idx on public.releases (target_pack_id);
-- At most one published release per campaign.
create unique index releases_one_published_idx
  on public.releases (campaign_id) where status = 'published';

-- The circular reference, added now that both tables exist. The composite key
-- means a campaign can only point at one of its own releases.
alter table public.campaigns
  add constraint campaigns_live_release_fk
  foreign key (live_release_id, id)
  references public.releases (id, campaign_id) on delete restrict;

create index campaigns_live_release_idx on public.campaigns (live_release_id);

-- --------------------------------------------------------------- user_roles
-- No row = no CMS access.
create table public.user_roles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  granted_by uuid references auth.users (id) on delete set null
);

-- ---------------------------------------------------------------- audit_log
-- Append-only. Rows are written by triggers, never by clients.
create table public.audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid,
  action     text not null,
  entity     text not null,
  entity_id  text,
  detail     jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_created_idx on public.audit_log (created_at desc);
create index audit_log_entity_idx on public.audit_log (entity, entity_id, created_at desc);

commit;
