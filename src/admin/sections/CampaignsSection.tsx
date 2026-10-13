import { useState, type FormEvent } from 'react';
import {
  createCampaign,
  listCampaigns,
  setCampaignStatus,
  updateCampaign,
} from '../../cms/campaignService';
import type { Campaign } from '../../cms/types';
import { hasRole, isValidSlug, slugify, type CmsRole } from '../../cms/validation';
import { Badge, Field, Notice } from '../components';
import { useAction, useAsync, type Navigate } from '../hooks';

function CampaignForm({
  campaign,
  busy,
  onSave,
  onCancel,
}: {
  campaign: Campaign | null;
  busy: boolean;
  onSave: (input: { name: string; slug: string; description: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(campaign?.name ?? '');
  const [slug, setSlug] = useState(campaign?.slug ?? '');
  const [description, setDescription] = useState(campaign?.description ?? '');
  // A new campaign's slug follows its name until the slug is typed by hand.
  const [slugTouched, setSlugTouched] = useState(campaign !== null);

  const slugOk = isValidSlug(slug);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (slugOk) {
      onSave({ name: name.trim(), slug, description: description.trim() });
    }
  };

  return (
    <form className="admin-panel admin-form" onSubmit={submit}>
      <h3>{campaign ? `Edit ${campaign.name}` : 'New campaign'}</h3>
      <div className="admin-form__columns">
        <Field label="Name">
          <input
            type="text"
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);

              if (!slugTouched) {
                setSlug(slugify(event.target.value));
              }
            }}
          />
        </Field>
        <Field label="Slug (lower-case letters, numbers and dashes)">
          <input
            type="text"
            value={slug}
            required
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => {
              setSlug(event.target.value);
              setSlugTouched(true);
            }}
          />
        </Field>
      </div>
      {slug && !slugOk && (
        <Notice kind="warn">
          Use only lower-case letters, numbers and single dashes, for example{' '}
          <span className="admin-mono">{slugify(slug) || 'summer-2026'}</span>.
        </Notice>
      )}
      {campaign && slug !== campaign.slug && (
        <Notice kind="warn">
          The slug will be part of the scanner link. Changing it later breaks
          links and QR codes that were already shared.
        </Notice>
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
          disabled={busy || !slugOk || !name.trim()}
        >
          {campaign ? 'Save changes' : 'Create campaign'}
        </button>
        <button className="admin-button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function CampaignsSection({
  role,
  navigate,
}: {
  role: CmsRole;
  navigate: Navigate;
}) {
  const canEdit = hasRole(role, 'editor');
  const campaigns = useAsync(listCampaigns, 'campaigns');
  const { busy, message, run } = useAction();
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const save = (input: { name: string; slug: string; description: string }) =>
    void run(async () => {
      if (editing === 'new') {
        await createCampaign(input);
      } else if (editing) {
        await updateCampaign(editing.id, input);
      }

      setEditing(null);
      campaigns.reload();
      return 'Campaign saved.';
    });

  const setStatus = (campaign: Campaign, status: Campaign['status']) => {
    if (
      status === 'archived' &&
      !window.confirm(
        `Archive "${campaign.name}"? It is hidden, not deleted, and can be restored.`,
      )
    ) {
      return;
    }

    void run(async () => {
      await setCampaignStatus(campaign.id, status);
      campaigns.reload();
      return status === 'archived' ? 'Campaign archived.' : 'Campaign restored.';
    });
  };

  const all = campaigns.data ?? [];
  const visible = all.filter(
    (campaign) => showArchived || campaign.status === 'active',
  );
  const archivedCount = all.length - all.filter((c) => c.status === 'active').length;

  return (
    <>
      <div className="admin-toolbar">
        <h2>Campaigns</h2>
        <div className="admin-row">
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
          {canEdit && editing === null && (
            <button
              className="admin-button admin-button--primary"
              type="button"
              onClick={() => setEditing('new')}
            >
              New campaign
            </button>
          )}
        </div>
      </div>

      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {campaigns.error && <Notice kind="error">{campaigns.error}</Notice>}

      {editing !== null && (
        <CampaignForm
          key={editing === 'new' ? 'new' : editing.id}
          campaign={editing === 'new' ? null : editing}
          busy={busy}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}

      <div className="admin-list">
        {visible.map((campaign) => (
          <div
            key={campaign.id}
            className={`admin-item${campaign.status === 'archived' ? ' admin-item--archived' : ''}`}
          >
            <div>
              <div className="admin-item__title">
                {campaign.name}
                <Badge label={campaign.status} />
              </div>
              <span className="admin-mono admin-muted">{campaign.slug}</span>
              {campaign.description && (
                <p className="admin-small admin-muted">{campaign.description}</p>
              )}
            </div>
            <div className="admin-row">
              <button
                className="admin-button admin-button--small"
                type="button"
                onClick={() => navigate('artworks', campaign.id)}
              >
                Artworks
              </button>
              {canEdit && (
                <>
                  <button
                    className="admin-button admin-button--small"
                    type="button"
                    disabled={busy}
                    onClick={() => setEditing(campaign)}
                  >
                    Edit
                  </button>
                  <button
                    className="admin-button admin-button--small"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setStatus(
                        campaign,
                        campaign.status === 'active' ? 'archived' : 'active',
                      )
                    }
                  >
                    {campaign.status === 'active' ? 'Archive' : 'Restore'}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {campaigns.data && visible.length === 0 && (
          <p className="admin-muted">No campaigns to show.</p>
        )}
        {campaigns.loading && !campaigns.data && (
          <p className="admin-muted">Loading...</p>
        )}
      </div>
    </>
  );
}
