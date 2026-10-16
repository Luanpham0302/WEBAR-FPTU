import { useState } from 'react';
import { listCampaigns } from '../../cms/campaignService';
import {
  createRelease,
  listReleases,
  publishRelease,
  verifyTargetPackTrusted,
  type CmsRelease,
} from '../../cms/releaseService';
import { listTargetPacks } from '../../cms/targetPackService';
import type { TargetPack } from '../../cms/types';
import { hasRole, type CmsRole } from '../../cms/validation';
import { Badge, Field, Notice } from '../components';
import { useAction, useAsync } from '../hooks';

export default function ReleasesSection({
  role,
  campaignId,
}: {
  role: CmsRole;
  campaignId: string | null;
}) {
  const canEdit = hasRole(role, 'editor');
  const canPublish = hasRole(role, 'admin');
  const campaigns = useAsync(listCampaigns, 'releases:campaigns');
  const allCampaigns = campaigns.data ?? [];
  const selected = allCampaigns.find((campaign) => campaign.id === campaignId)
    ?? allCampaigns.find((campaign) => campaign.status === 'active')
    ?? allCampaigns[0];
  const activeId = selected?.id ?? '';

  const packs = useAsync(
    () => activeId ? listTargetPacks(activeId) : Promise.resolve([]),
    'releases:packs:' + activeId,
  );
  const releases = useAsync(
    () => activeId ? listReleases(activeId) : Promise.resolve([]),
    'releases:list:' + activeId,
  );
  const { busy, message, run } = useAction();
  const [packSelection, setPackSelection] = useState('');
  const [notes, setNotes] = useState('');
  const activePacks = (packs.data ?? []).filter((pack) => pack.status === 'verified');
  const chosenPack = activePacks.find((pack) => pack.id === packSelection) ?? activePacks[0];
  const published = (releases.data ?? []).find((r) => r.status === 'published');

  const verify = (pack: TargetPack) => void run(async () => {
    await verifyTargetPackTrusted(pack.id);
    return 'Trusted backend verified pack v' + pack.version + '. It can now be used for a release.';
  }, 'Downloading and checking .mind file on the server...');

  const create = () => {
    if (!chosenPack) return;
    void run(async () => {
      await createRelease(chosenPack.id, notes);
      setNotes('');
      releases.reload();
      return 'Immutable preview release created. Open Preview to check it before publishing.';
    }, 'Creating release snapshot...');
  };

  const publish = (release: CmsRelease) => {
    const action = release.status === 'superseded' ? 'ROLL BACK to' : 'PUBLISH';
    if (!window.confirm(
      action + ' release v' + release.version + '? This changes the public Staging scanner for the entire site.',
    )) return;

    void run(async () => {
      await publishRelease(release.id);
      releases.reload();
      campaigns.reload();
      return release.status === 'superseded'
        ? 'Rollback completed on Staging.'
        : 'Release published on Staging.';
    }, 'Updating site-wide live release...');
  };

  if (campaigns.error) return <Notice kind="error">{campaigns.error}</Notice>;
  if (campaigns.loading && !campaigns.data) return <p className="admin-muted">Loading campaigns...</p>;

  return (
    <>
      <div className="admin-toolbar">
        <h2>Releases &amp; Publishing</h2>
        <select
          aria-label="Campaign"
          value={activeId}
          onChange={(event) => { window.location.hash = '/releases/' + encodeURIComponent(event.target.value); }}
        >
          {allCampaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
          ))}
        </select>
      </div>

      {!selected && <Notice>Create a campaign in Campaigns before building a release.</Notice>}
      <Notice>
        The CMS publishes a single campaign across the site. Release creation snapshots
        the saved artwork layers; later edits do not change that snapshot. Preview is private.
        Only Admin can publish or roll back.
      </Notice>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {packs.error && <Notice kind="error">{packs.error}</Notice>}
      {releases.error && <Notice kind="error">{releases.error}</Notice>}

      {selected && (
        <>
          <div className="admin-panel">
            <h3>Trusted target pack verification</h3>
            <p className="admin-small admin-muted">
              Storing a pack as VERIFIED does not certify its contents. Click
              Verify on the server to check the actual bytes, SHA-256, MindAR v2
              format, target count and dimensions. Requires the Staging Edge Function.
            </p>
            {(packs.data ?? []).map((pack) => (
              <div key={pack.id} className="admin-item">
                <div className="admin-row">
                  <strong>Target pack v{pack.version}</strong>
                  <Badge label={pack.status} />
                  <span className="admin-small admin-muted">{pack.target_count} targets</span>
                </div>
                {canEdit && pack.status === 'verified' && (
                  <button
                    className="admin-button admin-button--small"
                    disabled={busy}
                    type="button"
                    onClick={() => verify(pack)}
                  >
                    Verify on server
                  </button>
                )}
              </div>
            ))}
            {packs.data && packs.data.length === 0 && (
              <p className="admin-muted">No Target Packs yet. Create one in Target Packs first.</p>
            )}
          </div>

          {canEdit && (
            <div className="admin-panel">
              <h3>Create preview release</h3>
              <p className="admin-small admin-muted">
                The selected pack must pass trusted server verification first.
                An immutable manifest is built by Postgres from frozen target indices and current layers.
              </p>
              <Field label="Verified target pack">
                <select
                  disabled={busy || activePacks.length === 0}
                  value={chosenPack?.id ?? ''}
                  onChange={(event) => setPackSelection(event.target.value)}
                >
                  {activePacks.map((pack) => (
                    <option value={pack.id} key={pack.id}>Target pack v{pack.version}</option>
                  ))}
                </select>
              </Field>
              <Field label="Release notes (optional)">
                <textarea
                  maxLength={2000}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  disabled={busy}
                />
              </Field>
              <div className="admin-row">
                <button
                  type="button"
                  className="admin-button admin-button--primary"
                  disabled={busy || !chosenPack}
                  onClick={create}
                >
                  Create preview release
                </button>
              </div>
            </div>
          )}

          <div className="admin-panel">
            <div className="admin-toolbar">
              <h3>Release history</h3>
              <button type="button" className="admin-button admin-button--small"
                onClick={() => releases.reload()}>
                Refresh
              </button>
            </div>
            {published && (
              <Notice kind="good">Campaign {selected.name}: Release v{published.version} is published.</Notice>
            )}
            {(releases.data ?? []).map((release) => (
              <div className="admin-item" key={release.id}>
                <div>
                  <div className="admin-item__title">
                    Release v{release.version} <Badge label={release.status} />
                  </div>
                  <div className="admin-small admin-muted">
                    {new Date(release.created_at).toLocaleString()}
                    {release.notes ? ' · ' + release.notes : ''}
                  </div>
                  <div className="admin-mono admin-muted">Pack: {release.target_pack_id}</div>
                </div>
                <div className="admin-row">
                  <a
                    className="admin-button admin-button--small"
                    href={'/?preview=' + encodeURIComponent(release.preview_token)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Preview
                  </a>
                  {canPublish && release.status !== 'published' && (
                    <button
                      type="button"
                      className="admin-button admin-button--small admin-button--primary"
                      disabled={busy}
                      onClick={() => publish(release)}
                    >
                      {release.status === 'superseded' ? 'Rollback' : 'Publish'}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {releases.data && releases.data.length === 0 && (
              <p className="admin-muted">No release created yet.</p>
            )}
          </div>
        </>
      )}
    </>
  );
}
