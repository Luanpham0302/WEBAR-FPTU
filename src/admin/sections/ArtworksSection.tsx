import { useState, type ChangeEvent, type FormEvent } from 'react';
import {
  createArtwork,
  duplicateArtwork,
  listArtworks,
  nextSortOrder,
  setArtworkTrigger,
  updateArtwork,
  type ArtworkInput,
} from '../../cms/artworkService';
import { listCampaigns } from '../../cms/campaignService';
import {
  TRIGGER_MIN_RECOMMENDED_SIDE,
  uploadTriggerMedia,
} from '../../cms/mediaService';
import type { ArtworkStatus, ArtworkWithTrigger } from '../../cms/types';
import { formatBytes, hasRole, type CmsRole } from '../../cms/validation';
import { Badge, Field, MediaPreview, Notice } from '../components';
import { useAction, useAsync, type Navigate } from '../hooks';

function ArtworkForm({
  artwork,
  defaultSortOrder,
  busy,
  onSave,
  onCancel,
}: {
  artwork: ArtworkWithTrigger | null;
  defaultSortOrder: number;
  busy: boolean;
  onSave: (input: ArtworkInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(artwork?.name ?? '');
  const [description, setDescription] = useState(artwork?.description ?? '');
  const [category, setCategory] = useState(artwork?.category ?? '');
  const [status, setStatus] = useState<ArtworkStatus>(artwork?.status ?? 'draft');
  const [sortOrder, setSortOrder] = useState(
    String(artwork?.sort_order ?? defaultSortOrder),
  );

  const hasTrigger = Boolean(artwork?.trigger_media_id);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      name: name.trim(),
      description: description.trim(),
      category: category.trim(),
      status,
      sort_order: Number.parseInt(sortOrder, 10) || 0,
    });
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      <div className="admin-form__columns">
        <Field label="Name">
          <input
            type="text"
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Category">
          <input
            type="text"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          />
        </Field>
        <Field label="Status">
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as ArtworkStatus)}
          >
            <option value="draft">Draft (left out of the next build)</option>
            <option value="ready" disabled={!hasTrigger}>
              Ready (included in the next build)
            </option>
            {status === 'archived' && <option value="archived">Archived</option>}
          </select>
        </Field>
        <Field label="Sort order">
          <input
            type="number"
            step={1}
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
          />
        </Field>
      </div>
      {!hasTrigger && (
        <p className="admin-small admin-muted">
          An artwork can be marked Ready once it has a trigger image.
        </p>
      )}
      <Field label="Description">
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <div className="admin-row">
        <button
          className="admin-button admin-button--primary"
          disabled={busy || !name.trim()}
        >
          {artwork ? 'Save changes' : 'Create artwork'}
        </button>
        <button className="admin-button" type="button" onClick={onCancel}>
          {artwork ? 'Close' : 'Cancel'}
        </button>
      </div>
    </form>
  );
}

function TriggerPanel({
  artwork,
  canEdit,
  busy,
  onUpload,
}: {
  artwork: ArtworkWithTrigger;
  canEdit: boolean;
  busy: boolean;
  onUpload: (file: File) => void;
}) {
  const { trigger } = artwork;

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    // Lets the same file be chosen again after an error.
    event.target.value = '';

    if (file) {
      onUpload(file);
    }
  };

  const isSmall =
    trigger !== null &&
    Math.min(artwork.trigger_width ?? 0, artwork.trigger_height ?? 0) <
      TRIGGER_MIN_RECOMMENDED_SIDE;

  return (
    <div className="admin-form">
      <h3>Trigger image</h3>
      <MediaPreview media={trigger} />
      {trigger ? (
        <div className="admin-small">
          <div>
            {artwork.trigger_width} x {artwork.trigger_height} px,{' '}
            {formatBytes(trigger.file_size)}
          </div>
          <div className="admin-mono admin-muted">
            sha256 {artwork.trigger_sha256}
          </div>
        </div>
      ) : (
        <p className="admin-small admin-muted">No trigger image yet.</p>
      )}
      {isSmall && (
        <Notice kind="warn">
          This image is small. Tracking works best when the shorter side is at
          least {TRIGGER_MIN_RECOMMENDED_SIDE} px.
        </Notice>
      )}
      {canEdit && (
        <Field label={trigger ? 'Replace with a new PNG or JPEG' : 'Upload a PNG or JPEG'}>
          <input
            type="file"
            accept="image/png,image/jpeg"
            disabled={busy}
            onChange={handleFile}
          />
        </Field>
      )}
      <p className="admin-small admin-muted">
        Trigger images are stored privately. Uploading one does not change the
        live scanner: it only takes effect after a target pack is compiled and
        a release is published.
      </p>
    </div>
  );
}

export default function ArtworksSection({
  role,
  campaignId,
  navigate,
}: {
  role: CmsRole;
  campaignId: string | null;
  navigate: Navigate;
}) {
  const canEdit = hasRole(role, 'editor');
  const campaigns = useAsync(listCampaigns, 'campaigns');
  const { busy, message, run } = useAction();
  // An artwork id, 'new', or nothing open.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const campaignList = campaigns.data ?? [];
  const campaign =
    campaignList.find((item) => item.id === campaignId) ??
    campaignList.find((item) => item.status === 'active') ??
    campaignList[0] ??
    null;
  const activeCampaignId = campaign?.id ?? null;

  const artworks = useAsync(
    () => (activeCampaignId ? listArtworks(activeCampaignId) : Promise.resolve([])),
    activeCampaignId ?? 'none',
  );

  const list = artworks.data ?? [];
  const visible = list.filter(
    (artwork) => showArchived || artwork.status !== 'archived',
  );
  const archivedCount = list.filter((a) => a.status === 'archived').length;
  const editing = list.find((artwork) => artwork.id === editingId) ?? null;

  const save = (input: ArtworkInput) =>
    void run(async () => {
      if (editing) {
        await updateArtwork(editing.id, input);
      } else if (activeCampaignId) {
        // Stay on the new artwork so its trigger can be uploaded next.
        setEditingId((await createArtwork(activeCampaignId, input)).id);
      }

      artworks.reload();
      return editing ? 'Artwork saved.' : 'Artwork created. Add its trigger image below.';
    });

  const uploadTrigger = (artwork: ArtworkWithTrigger, file: File) =>
    void run(async () => {
      const media = await uploadTriggerMedia({
        file,
        campaignId: artwork.campaign_id,
        artworkId: artwork.id,
        name: `${artwork.name} trigger`,
      });

      await setArtworkTrigger(artwork.id, media);
      artworks.reload();
      return 'Trigger image stored.';
    }, `Uploading ${file.name}...`);

  const duplicate = (artwork: ArtworkWithTrigger) =>
    void run(async () => {
      const copy = await duplicateArtwork(artwork);

      setEditingId(copy.id);
      artworks.reload();
      return 'Copied as a draft. The copy needs its own trigger image.';
    });

  const setStatus = (artwork: ArtworkWithTrigger, status: ArtworkStatus) => {
    if (
      status === 'archived' &&
      !window.confirm(
        `Archive "${artwork.name}"? It is hidden, not deleted, and can be restored.`,
      )
    ) {
      return;
    }

    void run(async () => {
      await updateArtwork(artwork.id, { status });
      artworks.reload();
      return status === 'archived' ? 'Artwork archived.' : 'Artwork restored as a draft.';
    });
  };

  if (campaigns.loading && !campaigns.data) {
    return <p className="admin-muted">Loading...</p>;
  }

  if (campaigns.error) {
    return <Notice kind="error">{campaigns.error}</Notice>;
  }

  if (!campaign) {
    return (
      <>
        <h2>Artworks</h2>
        <Notice>
          Artworks belong to a campaign.{' '}
          <a
            href="#/campaigns"
            onClick={(event) => {
              event.preventDefault();
              navigate('campaigns');
            }}
          >
            Create a campaign first
          </a>
          .
        </Notice>
      </>
    );
  }

  return (
    <>
      <div className="admin-toolbar">
        <h2>Artworks</h2>
        <div className="admin-row">
          <select
            aria-label="Campaign"
            value={campaign.id}
            onChange={(event) => {
              setEditingId(null);
              navigate('artworks', event.target.value);
            }}
          >
            {campaignList.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.status === 'archived' ? ' (archived)' : ''}
              </option>
            ))}
          </select>
          {canEdit && editingId === null && (
            <button
              className="admin-button admin-button--primary"
              type="button"
              onClick={() => setEditingId('new')}
            >
              New artwork
            </button>
          )}
        </div>
      </div>

      {archivedCount > 0 && (
        <label className="admin-row admin-small">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived ({archivedCount})
        </label>
      )}

      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {artworks.error && <Notice kind="error">{artworks.error}</Notice>}

      {editingId !== null && (editingId === 'new' || editing) && (
        <div className="admin-panel">
          <h3>{editing ? `Edit ${editing.name}` : 'New artwork'}</h3>
          <ArtworkForm
            key={editing?.id ?? 'new'}
            artwork={editing}
            defaultSortOrder={nextSortOrder(list)}
            busy={busy || !canEdit}
            onSave={save}
            onCancel={() => setEditingId(null)}
          />
          {editing && (
            <TriggerPanel
              artwork={editing}
              canEdit={canEdit}
              busy={busy}
              onUpload={(file) => uploadTrigger(editing, file)}
            />
          )}
        </div>
      )}

      <div className="admin-list">
        {visible.map((artwork) => (
          <div
            key={artwork.id}
            className={`admin-item admin-item--with-thumb${artwork.status === 'archived' ? ' admin-item--archived' : ''}`}
          >
            <MediaPreview media={artwork.trigger} thumb />
            <div>
              <div className="admin-item__title">
                {artwork.name}
                <Badge label={artwork.status} />
              </div>
              <div className="admin-small admin-muted">
                #{artwork.sort_order}
                {artwork.category ? ` · ${artwork.category}` : ''}
                {artwork.trigger_width
                  ? ` · trigger ${artwork.trigger_width} x ${artwork.trigger_height}`
                  : ' · no trigger'}
              </div>
            </div>
            <div className="admin-row">
              <button
                className="admin-button admin-button--small"
                type="button"
                onClick={() => setEditingId(artwork.id)}
              >
                {canEdit ? 'Edit' : 'View'}
              </button>
              {canEdit && (
                <>
                  <button
                    className="admin-button admin-button--small"
                    type="button"
                    disabled={busy}
                    onClick={() => duplicate(artwork)}
                  >
                    Duplicate
                  </button>
                  <button
                    className="admin-button admin-button--small"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setStatus(
                        artwork,
                        artwork.status === 'archived' ? 'draft' : 'archived',
                      )
                    }
                  >
                    {artwork.status === 'archived' ? 'Restore' : 'Archive'}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {artworks.data && visible.length === 0 && (
          <p className="admin-muted">No artworks in this campaign yet.</p>
        )}
        {artworks.loading && !artworks.data && (
          <p className="admin-muted">Loading...</p>
        )}
      </div>
    </>
  );
}
