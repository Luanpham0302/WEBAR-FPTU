import { listCampaigns, loadCounts } from '../../cms/campaignService';
import type { CmsRole } from '../../cms/validation';
import { Badge, Notice } from '../components';
import { useAsync, type Navigate } from '../hooks';

const ROLE_SUMMARY: Record<CmsRole, string> = {
  viewer: 'You can look at everything and change nothing.',
  editor: 'You can create and edit campaigns, artworks and media.',
  admin: 'You can edit everything and publish to the live scanner.',
};

export default function DashboardSection({
  role,
  navigate,
}: {
  role: CmsRole;
  navigate: Navigate;
}) {
  const overview = useAsync(
    async () => ({
      counts: await loadCounts(),
      campaigns: await listCampaigns(),
    }),
    'dashboard',
  );

  return (
    <>
      <div className="admin-toolbar">
        <h2>Dashboard</h2>
        <span className="admin-muted admin-small">{ROLE_SUMMARY[role]}</span>
      </div>

      {overview.error && <Notice kind="error">{overview.error}</Notice>}

      {overview.data && (
        <>
          <div className="admin-stats">
            <div className="admin-panel">
              <span className="admin-muted admin-small">Campaigns</span>
              <span className="admin-stat__value">
                {overview.data.counts.campaigns}
              </span>
            </div>
            <div className="admin-panel">
              <span className="admin-muted admin-small">Artworks</span>
              <span className="admin-stat__value">
                {overview.data.counts.artworks}
              </span>
            </div>
            <div className="admin-panel">
              <span className="admin-muted admin-small">Media files</span>
              <span className="admin-stat__value">
                {overview.data.counts.media}
              </span>
            </div>
          </div>

          <div className="admin-panel">
            <h3>What is live</h3>
            <p className="admin-muted admin-small">
              The scanner still runs the built-in profiles. Campaigns are
              working copies until target packs and releases arrive in the
              next phases, so nothing edited here reaches visitors yet.
            </p>
            <div className="admin-list">
              {overview.data.campaigns
                .filter((campaign) => campaign.status === 'active')
                .map((campaign) => (
                  <div className="admin-item" key={campaign.id}>
                    <div>
                      <div className="admin-item__title">
                        {campaign.name}
                        <Badge
                          label={
                            campaign.live_release_id ? 'live' : 'no live release'
                          }
                        />
                      </div>
                      <span className="admin-mono admin-muted">
                        {campaign.slug}
                      </span>
                    </div>
                    <button
                      className="admin-button admin-button--small"
                      type="button"
                      onClick={() => navigate('artworks', campaign.id)}
                    >
                      Artworks
                    </button>
                  </div>
                ))}
              {overview.data.campaigns.length === 0 && (
                <p className="admin-muted">
                  No campaigns yet.{' '}
                  <a
                    href="#/campaigns"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate('campaigns');
                    }}
                  >
                    Create the first one
                  </a>
                  .
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {overview.loading && !overview.data && (
        <p className="admin-muted">Loading...</p>
      )}
    </>
  );
}
