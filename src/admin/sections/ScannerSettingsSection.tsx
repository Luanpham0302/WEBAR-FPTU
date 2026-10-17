import { useEffect, useState, type ChangeEvent } from 'react';
import { SCANNER_ASSET_KINDS, acceptFor } from '../../cms/mediaRules';
import {
  publishScannerSettings,
  uploadScannerAsset,
} from '../../cms/scannerSettingsService';
import {
  DEFAULT_AR_CONTENT,
  loadARContent,
  type ARContentConfig,
} from '../../lib/contentService';
import { Badge, Notice } from '../components';
import { useAction } from '../hooks';

type FieldSpec = {
  key: keyof ARContentConfig;
  label: string;
  accept: string;
  video: boolean;
};

const fieldSpec = (key: keyof ARContentConfig, label: string): FieldSpec => ({
  key,
  label,
  accept: acceptFor(SCANNER_ASSET_KINDS[key]),
  video: SCANNER_ASSET_KINDS[key] === 'VIDEO',
});

// PNG, JPEG or WebP images and MP4 or WebM videos only (no SVG): the
// ar-assets bucket refuses anything else.
const FIELDS: FieldSpec[] = [
  fieldSpec('scannerBorder', 'Scanner Border'),
  fieldSpec('scannerTitle', 'AR Scanner Title'),
  fieldSpec('scannerFrame', 'Scanner Frame'),
  fieldSpec('scannerBottom', 'Bottom Decoration'),
  fieldSpec('loadingAnimation', 'Loading Animation'),
  fieldSpec('animation01', 'AR Video 01'),
  fieldSpec('animation02', 'AR Video 02'),
  fieldSpec('animation03', 'AR Video 03'),
];

// Branding assets and the three legacy videos.
//
// `published` is what scanner visitors get. `draft` is what this page shows.
// An upload goes to a new file of its own and only changes the draft; the
// live scanner changes when Publish writes the draft to ar_content.
export default function ScannerSettingsSection({
  canUpload,
  canPublish,
}: {
  canUpload: boolean;
  canPublish: boolean;
}) {
  const [published, setPublished] = useState<ARContentConfig | null>(null);
  const [draft, setDraft] = useState<ARContentConfig>(DEFAULT_AR_CONTENT);
  const [loadFailed, setLoadFailed] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const { busy, message, run } = useAction();

  useEffect(() => {
    let active = true;

    void loadARContent().then(({ config, status }) => {
      if (!active) {
        return;
      }

      setPublished(config);
      setDraft(config);
      setLoadFailed(status === 'error');
    });

    return () => {
      active = false;
    };
  }, []);

  const pendingKeys = published
    ? FIELDS.filter((field) => draft[field.key] !== published[field.key]).map(
        (field) => field.key,
      )
    : [];
  const hasPending = pendingKeys.length > 0;

  // Pending uploads exist only in this page until they are published.
  useEffect(() => {
    if (!hasPending) {
      return;
    }

    const warn = (event: BeforeUnloadEvent) => event.preventDefault();

    window.addEventListener('beforeunload', warn);

    return () => window.removeEventListener('beforeunload', warn);
  }, [hasPending]);

  const handleUpload = (
    key: keyof ARContentConfig,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];

    event.target.value = '';

    if (!file) {
      return;
    }

    setUploading(key);

    void run(async () => {
      const url = await uploadScannerAsset(key, file);

      setDraft((current) => ({ ...current, [key]: url }));
      return 'Upload thành công. Nhấn Publish để áp dụng.';
    }, `Uploading ${file.name}...`).finally(() => setUploading(null));
  };

  const publish = () =>
    void run(async () => {
      await publishScannerSettings(draft);
      setPublished(draft);
      return 'Publish thành công!';
    }, 'Publishing...');

  if (!published) {
    return <p className="admin-muted">Loading...</p>;
  }

  return (
    <>
      <div className="admin-toolbar">
        <div>
          <h2>Scanner Settings</h2>
          <p className="admin-muted admin-small">
            Scanner frame, loading animation and the three legacy AR videos.
            Nothing changes for visitors until you press Publish.
          </p>
        </div>
        {hasPending && <Badge label={`${pendingKeys.length} pending`} />}
      </div>

      {loadFailed && (
        <Notice kind="error">
          The published settings could not be read, so the built-in defaults
          are shown. Publishing now would replace the live settings with what
          is on this page.
        </Notice>
      )}
      {!canPublish && (
        <Notice>
          {canUpload
            ? 'You can upload and preview assets. Only an Admin can publish them.'
            : 'You have read-only access to these settings.'}
        </Notice>
      )}
      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <div className="admin-grid">
        {FIELDS.map((field) => {
          const src = draft[field.key];
          const isPending = pendingKeys.includes(field.key);

          return (
            <div className="admin-panel" key={field.key}>
              <div className="admin-item__title">
                {field.label}
                {isPending && <Badge label="pending" />}
              </div>
              <div className="admin-preview">
                {!src ? (
                  <span className="admin-muted">Not set</span>
                ) : field.video ? (
                  <video src={src} controls muted playsInline preload="metadata" />
                ) : (
                  <img src={src} alt="" />
                )}
              </div>
              {canUpload && (
                <input
                  type="file"
                  accept={field.accept}
                  disabled={busy}
                  aria-label={`Replace ${field.label}`}
                  onChange={(event) => handleUpload(field.key, event)}
                />
              )}
              {uploading === field.key && <p>Uploading...</p>}
              {isPending && (
                <button
                  className="admin-button admin-button--small"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      [field.key]: published[field.key],
                    }))
                  }
                >
                  Undo
                </button>
              )}
            </div>
          );
        })}
      </div>

      {canUpload && (
        <div className="admin-row">
          <button
            className="admin-button admin-button--primary"
            type="button"
            disabled={busy || !canPublish || !hasPending}
            onClick={publish}
          >
            Publish Changes
          </button>
          <button
            className="admin-button"
            type="button"
            disabled={busy}
            onClick={() => setDraft(DEFAULT_AR_CONTENT)}
          >
            Reset to Default
          </button>
          <button
            className="admin-button"
            type="button"
            disabled={busy || !hasPending}
            onClick={() => setDraft(published)}
          >
            Discard changes
          </button>
        </div>
      )}
    </>
  );
}
