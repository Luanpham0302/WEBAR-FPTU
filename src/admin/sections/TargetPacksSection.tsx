import { useEffect, useState } from 'react';
import { listArtworks } from '../../cms/artworkService';
import { listCampaigns } from '../../cms/campaignService';
import { MINDAR_COMPILER_VERSION } from '../../cms/manifest';
import { mediaRef } from '../../cms/mediaService';
import { getStorage, type ObjectRef } from '../../cms/storage';
import {
  compileTargetPack,
  storageSourceLoader,
  type CompileProgress,
  type CompiledPack,
} from '../../cms/targetCompiler';
import {
  computeSourceHash,
  gradeFeatureCount,
  gradeTarget,
  orderCompileSources,
  type CompileSource,
} from '../../cms/targetPack';
import {
  isInterrupted,
  listPackItems,
  listTargetPacks,
  saveCompiledPack,
  setPackStatus,
  type SaveStep,
} from '../../cms/targetPackService';
import {
  checkTriggerImage,
  duplicateIssue,
  findDuplicateTrigger,
  hasBlockingIssue,
  type TriggerIssue,
} from '../../cms/triggerRules';
import type { ArtworkWithTrigger, TargetPack } from '../../cms/types';
import { formatBytes, hasRole, type CmsRole } from '../../cms/validation';
import { describeError } from '../../cms/errors';
import { Badge, MediaPreview, Notice } from '../components';
import { useAction, useAsync, type Navigate } from '../hooks';

type BuildState =
  | { kind: 'idle' }
  | { kind: 'compiling'; progress: CompileProgress }
  | { kind: 'compiled'; pack: CompiledPack }
  | { kind: 'saving'; pack: CompiledPack; step: SaveStep };

const SAVE_STEP_TEXT: Record<SaveStep, string> = {
  reserving: 'Reserving the next version...',
  uploading: 'Uploading the target pack...',
  verifying: 'Checking the uploaded file...',
  done: 'Done.',
};

const PHASE_TEXT: Record<CompileProgress['phase'], string> = {
  loading: 'Step 1 of 3: checking trigger images',
  compiling: 'Step 2 of 3: compiling',
  verifying: 'Step 3 of 3: verifying',
};

type Preflight = {
  source: CompileSource;
  artwork: ArtworkWithTrigger;
  issues: TriggerIssue[];
};

// Checks every image that is about to be compiled, with the same rules the
// upload uses. Triggers stored before those rules existed are caught here.
function preflight(artworks: ArtworkWithTrigger[]): Preflight[] {
  const byId = new Map(artworks.map((artwork) => [artwork.id, artwork]));

  return orderCompileSources(artworks).map((source) => {
    const artwork = byId.get(source.artworkId) as ArtworkWithTrigger;
    const issues = artwork.trigger
      ? checkTriggerImage({
          mimeType: artwork.trigger.mime_type,
          width: source.width,
          height: source.height,
          fileSize: artwork.trigger.file_size,
        })
      : [
          {
            level: 'error' as const,
            code: 'format' as const,
            message: 'The trigger file record is missing. Upload the trigger again.',
          },
        ];
    const twin = findDuplicateTrigger(source.sha256, source.artworkId, artworks);

    if (twin) {
      issues.push(duplicateIssue(twin.name));
    }

    return { source, artwork, issues };
  });
}

function BuildPanel({
  campaignId,
  artworks,
  packs,
  onSaved,
  onReloadArtworks,
}: {
  campaignId: string;
  artworks: ArtworkWithTrigger[];
  packs: TargetPack[];
  onSaved: () => void;
  onReloadArtworks: () => void;
}) {
  const [build, setBuild] = useState<BuildState>({ kind: 'idle' });
  const [message, setMessage] = useState<{
    kind: 'good' | 'error' | 'warn';
    text: string;
  } | null>(null);
  const [acceptPoor, setAcceptPoor] = useState(false);

  const rows = preflight(artworks);
  const sources = rows.map((row) => row.source);
  const sourceKey = sources
    .map((source) => `${source.targetIndex}:${source.sha256}`)
    .join('|');
  const sourceHash = useAsync(
    () => computeSourceHash(sources, MINDAR_COMPILER_VERSION),
    sourceKey,
  );

  const blocked = rows.some((row) => hasBlockingIssue(row.issues));
  const latestVerified = packs.find((pack) => pack.status === 'verified');
  const unchangedPack =
    sources.length > 0 && sourceHash.data
      ? packs.find(
          (pack) =>
            pack.status === 'verified' &&
            pack.source_hash === sourceHash.data &&
            pack.compiler_version === MINDAR_COMPILER_VERSION,
        )
      : undefined;
  const leftOut = artworks.filter(
    (artwork) =>
      artwork.status !== 'archived' &&
      !sources.some((source) => source.artworkId === artwork.id),
  );

  const working = build.kind === 'compiling' || build.kind === 'saving';

  // A compile lives only in this tab until it is saved.
  useEffect(() => {
    if (build.kind === 'idle') {
      return;
    }

    const warn = (event: BeforeUnloadEvent) => event.preventDefault();

    window.addEventListener('beforeunload', warn);

    return () => window.removeEventListener('beforeunload', warn);
  }, [build.kind]);

  const compile = async () => {
    setMessage(null);
    setAcceptPoor(false);
    setBuild({
      kind: 'compiling',
      progress: { phase: 'loading', percent: 0, detail: 'Reading the artwork list...' },
    });

    try {
      // Compile what is in the database now, not what this page loaded
      // earlier: another editor may have changed an artwork since.
      const fresh = preflight(await listArtworks(campaignId));

      if (fresh.some((row) => hasBlockingIssue(row.issues))) {
        onReloadArtworks();
        throw new Error(
          'A trigger image has a problem that must be fixed first. The list below is up to date.',
        );
      }

      const refs = new Map<string, ObjectRef>();

      fresh.forEach(({ source, artwork }) => {
        if (artwork.trigger) {
          refs.set(source.triggerMediaId, mediaRef(artwork.trigger));
        }
      });

      const pack = await compileTargetPack(
        fresh.map((row) => row.source),
        storageSourceLoader(refs),
        (progress) => setBuild({ kind: 'compiling', progress }),
      );

      setBuild({ kind: 'compiled', pack });
    } catch (error) {
      console.error(error);
      setBuild({ kind: 'idle' });
      setMessage({ kind: 'error', text: describeError(error, 'The compile failed.') });
    }
  };

  const save = async (pack: CompiledPack) => {
    setMessage(null);
    setBuild({ kind: 'saving', pack, step: 'reserving' });

    try {
      const saved = await saveCompiledPack(campaignId, pack, (step) =>
        setBuild({ kind: 'saving', pack, step }),
      );

      setBuild({ kind: 'idle' });
      setMessage({
        kind: 'good',
        text: `Target pack v${saved.version} is stored and its upload was checked. It is not live: test it from the history below.`,
      });
      onSaved();
    } catch (error) {
      console.error(error);
      // The compiled file is still in memory, so saving can be tried again
      // (as a new version) without compiling again.
      setBuild({ kind: 'compiled', pack });
      setMessage({ kind: 'error', text: describeError(error, 'The pack could not be saved.') });
      onSaved();
      onReloadArtworks();
    }
  };

  const compiled = build.kind === 'compiled' || build.kind === 'saving' ? build.pack : null;
  const qualities = compiled?.targets.map(gradeTarget) ?? [];
  const poorCount = qualities.filter((quality) => quality.grade === 'poor').length;

  return (
    <div className="admin-panel">
      <h3>Build a new target pack</h3>
      <p className="admin-small admin-muted">
        A pack always contains every Ready artwork of the campaign, in the
        order shown. The row number is the targetIndex. To leave an artwork
        out, set it to Draft. Building a pack never changes what visitors
        see.
      </p>

      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      {rows.length === 0 ? (
        <Notice>
          No artwork is Ready. Give an artwork a trigger image and set its
          status to Ready to include it.
        </Notice>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Index</th>
                <th>Trigger</th>
                <th>Artwork</th>
                <th>Size</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ source, artwork, issues }) => (
                <tr key={source.artworkId}>
                  <td>{source.targetIndex}</td>
                  <td>
                    <MediaPreview media={artwork.trigger} thumb />
                  </td>
                  <td>{source.artworkName}</td>
                  <td>
                    {source.width} x {source.height}
                  </td>
                  <td>
                    {issues.length === 0 ? (
                      <Badge label="ok" />
                    ) : (
                      issues.map((issue) => (
                        <div
                          key={issue.code}
                          className={
                            issue.level === 'error' ? 'admin-text-error' : 'admin-text-warn'
                          }
                        >
                          {issue.message}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {leftOut.length > 0 && (
        <p className="admin-small admin-muted">
          Not in this pack ({leftOut.length}, not Ready):{' '}
          {leftOut.map((artwork) => artwork.name).join(', ')}
        </p>
      )}

      {unchangedPack && build.kind === 'idle' && (
        <Notice>
          Nothing has changed since target pack v{unchangedPack.version}. It
          already contains exactly these images in this order.
        </Notice>
      )}

      {build.kind === 'idle' && (
        <div className="admin-row">
          <button
            className="admin-button admin-button--primary"
            type="button"
            disabled={rows.length === 0 || blocked || Boolean(unchangedPack)}
            onClick={() => void compile()}
          >
            Compile {rows.length} {rows.length === 1 ? 'target' : 'targets'}
          </button>
          <span className="admin-small admin-muted">
            MindAR {MINDAR_COMPILER_VERSION}. Use a computer and keep this tab
            open; large images can take a few minutes.
            {latestVerified ? ` Latest verified pack: v${latestVerified.version}.` : ''}
          </span>
        </div>
      )}

      {build.kind === 'compiling' && (
        <div className="admin-form" role="status">
          <div>{PHASE_TEXT[build.progress.phase]}</div>
          <progress max={100} value={build.progress.percent} />
          <div className="admin-small admin-muted">
            {build.progress.detail} {Math.round(build.progress.percent)}%. Keep
            this tab open.
          </div>
        </div>
      )}

      {compiled && (
        <div className="admin-form">
          <h3>Compile result</h3>
          <Notice kind="good">
            Verified before upload: {compiled.targets.length} targets, each at
            the expected index with the expected size.{' '}
            {formatBytes(compiled.bytes.byteLength)}, compiled in{' '}
            {Math.round(compiled.durationMs / 1000)} s.
          </Notice>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Index</th>
                  <th>Artwork</th>
                  <th>Size in file</th>
                  <th>Detection features</th>
                  <th>Tracking points</th>
                  <th>Quality</th>
                </tr>
              </thead>
              <tbody>
                {compiled.sources.map((source, index) => (
                  <tr key={source.artworkId}>
                    <td>{index}</td>
                    <td>{source.artworkName}</td>
                    <td>
                      {compiled.targets[index].width} x {compiled.targets[index].height}
                    </td>
                    <td>{compiled.targets[index].matchingPoints}</td>
                    <td>{compiled.targets[index].trackingPoints.join(' / ')}</td>
                    <td>
                      <Badge label={qualities[index].grade} />
                      {qualities[index].reasons.map((reason) => (
                        <div key={reason} className="admin-small admin-muted">
                          {reason}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {poorCount > 0 && (
            <Notice kind="warn">
              {poorCount} {poorCount === 1 ? 'target has' : 'targets have'} poor
              tracking quality and may not be recognised reliably. Replacing
              the trigger image is the real fix.
              <label className="admin-row">
                <input
                  type="checkbox"
                  checked={acceptPoor}
                  disabled={working}
                  onChange={(event) => setAcceptPoor(event.target.checked)}
                />
                Save this pack anyway, for testing
              </label>
            </Notice>
          )}

          {build.kind === 'saving' ? (
            <div role="status">{SAVE_STEP_TEXT[build.step]} Keep this tab open.</div>
          ) : (
            <div className="admin-row">
              <button
                className="admin-button admin-button--primary"
                type="button"
                disabled={poorCount > 0 && !acceptPoor}
                onClick={() => void save(compiled)}
              >
                Save as a new target pack
              </button>
              <button
                className="admin-button"
                type="button"
                onClick={() => {
                  setBuild({ kind: 'idle' });
                  setMessage(null);
                }}
              >
                Discard
              </button>
              <span className="admin-small admin-muted">
                Nothing is stored until you save. Saving does not publish.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PackItems({ packId }: { packId: string }) {
  const items = useAsync(() => listPackItems(packId), packId);

  if (items.error) {
    return <Notice kind="error">{items.error}</Notice>;
  }

  if (!items.data) {
    return <p className="admin-muted">Loading...</p>;
  }

  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Index</th>
            <th>Artwork</th>
            <th>Size in file</th>
            <th>Detection features</th>
            <th>Quality</th>
            <th>Trigger sha256</th>
          </tr>
        </thead>
        <tbody>
          {items.data.map((item) => {
            const grade = gradeFeatureCount(item.feature_count);

            return (
              <tr key={item.target_index}>
                <td>{item.target_index}</td>
                <td>{item.artwork?.name ?? item.artwork_id}</td>
                <td>
                  {item.width} x {item.height}
                </td>
                <td>{item.feature_count ?? '-'}</td>
                <td>{grade ? <Badge label={grade} /> : '-'}</td>
                <td className="admin-mono">{item.trigger_sha256.slice(0, 16)}...</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TargetPacksSection({
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
  const [openPackId, setOpenPackId] = useState<string | null>(null);

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
  const packs = useAsync(
    () => (activeCampaignId ? listTargetPacks(activeCampaignId) : Promise.resolve([])),
    activeCampaignId ?? 'none',
  );

  const changeStatus = (
    pack: TargetPack,
    status: 'failed' | 'retired' | 'verified',
    done: string,
  ) =>
    void run(async () => {
      await setPackStatus(pack.id, status);
      packs.reload();
      return done;
    });

  const copyUrl = (pack: TargetPack) =>
    void run(async () => {
      await navigator.clipboard.writeText(
        getStorage(pack.storage_provider).getPublicUrl(pack.bucket, pack.storage_key),
      );
      return 'File URL copied.';
    });

  if (campaigns.loading && !campaigns.data) {
    return <p className="admin-muted">Loading...</p>;
  }

  if (campaigns.error) {
    return <Notice kind="error">{campaigns.error}</Notice>;
  }

  if (!campaign || !activeCampaignId) {
    return (
      <>
        <h2>Target Packs</h2>
        <Notice>
          A target pack belongs to a campaign.{' '}
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

  const packList = packs.data ?? [];

  return (
    <>
      <div className="admin-toolbar">
        <div>
          <h2>Target Packs</h2>
          <p className="admin-muted admin-small">
            A target pack is one compiled MindAR file for a campaign. Packs are
            numbered, never overwritten, and none of them is live until a
            release is published. "Verified" means the file was stored
            completely; it is not yet an approval to publish.
          </p>
        </div>
        <select
          aria-label="Campaign"
          value={campaign.id}
          onChange={(event) => {
            setOpenPackId(null);
            navigate('packs', event.target.value);
          }}
        >
          {campaignList.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.status === 'archived' ? ' (archived)' : ''}
            </option>
          ))}
        </select>
      </div>

      {artworks.error && <Notice kind="error">{artworks.error}</Notice>}

      {canEdit ? (
        artworks.data && (
          <BuildPanel
            // A different campaign is a different build: drop any compile.
            key={activeCampaignId}
            campaignId={activeCampaignId}
            artworks={artworks.data}
            packs={packList}
            onSaved={packs.reload}
            onReloadArtworks={artworks.reload}
          />
        )
      ) : (
        <Notice>You have read-only access. An Editor or Admin compiles target packs.</Notice>
      )}

      <h3>History</h3>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {packs.error && <Notice kind="error">{packs.error}</Notice>}

      <div className="admin-list">
        {packList.map((pack) => {
          const interrupted = isInterrupted(pack);
          const usable = pack.status === 'verified' || pack.status === 'retired';

          return (
            <div className="admin-panel" key={pack.id}>
              <div className="admin-toolbar">
                <div>
                  <div className="admin-item__title">
                    Target pack v{pack.version}
                    <Badge
                      label={
                        interrupted
                          ? 'interrupted'
                          : pack.status === 'uploaded'
                            ? 'uploading'
                            : pack.status
                      }
                    />
                  </div>
                  <div className="admin-small admin-muted">
                    {pack.target_count} {pack.target_count === 1 ? 'target' : 'targets'}
                    {' · '}
                    {formatBytes(pack.file_size)}
                    {' · '}MindAR {pack.compiler_version}
                    {' · '}
                    {new Date(pack.created_at).toLocaleString()}
                  </div>
                  <div className="admin-mono admin-muted">{pack.storage_key}</div>
                </div>
                <div className="admin-row">
                  <button
                    className="admin-button admin-button--small"
                    type="button"
                    aria-expanded={openPackId === pack.id}
                    onClick={() =>
                      setOpenPackId(openPackId === pack.id ? null : pack.id)
                    }
                  >
                    {openPackId === pack.id ? 'Hide targets' : 'Targets'}
                  </button>
                  {usable && (
                    <>
                      <a
                        className="admin-button admin-button--small"
                        href={`#/test/${pack.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Test
                      </a>
                      <button
                        className="admin-button admin-button--small"
                        type="button"
                        disabled={busy}
                        onClick={() => copyUrl(pack)}
                      >
                        Copy file URL
                      </button>
                    </>
                  )}
                  {canEdit && interrupted && (
                    <button
                      className="admin-button admin-button--small"
                      type="button"
                      disabled={busy}
                      onClick={() => changeStatus(pack, 'failed', 'Marked as failed.')}
                    >
                      Mark failed
                    </button>
                  )}
                  {canEdit && pack.status === 'verified' && (
                    <button
                      className="admin-button admin-button--small"
                      type="button"
                      disabled={busy}
                      onClick={() => changeStatus(pack, 'retired', 'Pack retired.')}
                    >
                      Retire
                    </button>
                  )}
                  {canEdit && pack.status === 'retired' && (
                    <button
                      className="admin-button admin-button--small"
                      type="button"
                      disabled={busy}
                      onClick={() => changeStatus(pack, 'verified', 'Pack restored.')}
                    >
                      Restore
                    </button>
                  )}
                </div>
              </div>
              {interrupted && (
                <p className="admin-small admin-muted">
                  This pack was started but its upload never finished. It cannot
                  be used. Mark it failed and compile again.
                </p>
              )}
              {pack.status === 'failed' && (
                <p className="admin-small admin-muted">
                  The upload or its check failed. This pack cannot be used.
                </p>
              )}
              {openPackId === pack.id && <PackItems packId={pack.id} />}
            </div>
          );
        })}
        {packs.data && packList.length === 0 && (
          <p className="admin-muted">No target pack has been built for this campaign yet.</p>
        )}
        {packs.loading && !packs.data && <p className="admin-muted">Loading...</p>}
      </div>
    </>
  );
}
