import { useEffect, useState, type ReactNode } from 'react';
import { describeError } from '../cms/errors';
import { mediaRef } from '../cms/mediaService';
import { resolveObjectUrl } from '../cms/storage';
import type { Media } from '../cms/types';

type NoticeKind = 'info' | 'good' | 'warn' | 'error';

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: NoticeKind;
  children: ReactNode;
}) {
  return (
    <div
      className={`admin-notice${kind === 'info' ? '' : ` admin-notice--${kind}`}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

const BADGE_TONE: Record<string, string> = {
  active: 'good',
  ready: 'good',
  admin: 'info',
  editor: 'info',
  viewer: 'info',
  draft: 'warn',
  pending: 'warn',
  verified: 'good',
  ok: 'good',
  good: 'good',
  fair: 'warn',
  uploading: 'warn',
  poor: 'bad',
  failed: 'bad',
  interrupted: 'bad',
};

export function Badge({ label }: { label: string }) {
  const tone = BADGE_TONE[label.toLowerCase()];

  return (
    <span className={`admin-badge${tone ? ` admin-badge--${tone}` : ''}`}>
      {label}
    </span>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="admin-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// Shows a stored media object. Images load at once (through a signed URL when
// the bucket is private); a video only loads when asked, so a long library
// does not start dozens of downloads.
export function MediaPreview({
  media,
  thumb = false,
}: {
  media: Media | null;
  thumb?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wanted, setWanted] = useState(false);

  const isImage = media?.type === 'IMAGE' || media?.type === 'TRIGGER';
  const shouldLoad = Boolean(media) && (isImage || wanted);

  useEffect(() => {
    setUrl(null);
    setError(null);

    if (!media || !shouldLoad) {
      return;
    }

    let active = true;

    resolveObjectUrl(mediaRef(media)).then(
      (resolved) => {
        if (active) {
          setUrl(resolved);
        }
      },
      (reason: unknown) => {
        if (active) {
          setError(describeError(reason, 'Preview unavailable.'));
        }
      },
    );

    return () => {
      active = false;
    };
    // The file behind a media id never changes, so the id is the whole key.
  }, [media?.id, shouldLoad]);

  const className = `admin-preview${thumb ? ' admin-thumb' : ''}`;

  if (!media) {
    return (
      <div className={className}>
        <span className="admin-muted">No image</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={className}>
        <span className="admin-muted">{thumb ? 'Unavailable' : error}</span>
      </div>
    );
  }

  if (!shouldLoad) {
    return (
      <div className={className}>
        <button
          className="admin-button admin-button--small"
          type="button"
          onClick={() => setWanted(true)}
        >
          {media.type === 'VIDEO' ? 'Load preview' : 'Get file link'}
        </button>
      </div>
    );
  }

  if (!url) {
    return (
      <div className={className}>
        <span className="admin-muted">Loading...</span>
      </div>
    );
  }

  return (
    <div className={className}>
      {isImage && <img src={url} alt={media.name} loading="lazy" />}
      {media.type === 'VIDEO' && (
        <video src={url} controls muted playsInline preload="metadata" />
      )}
      {media.type === 'MODEL_3D' && (
        <a href={url} target="_blank" rel="noreferrer">
          Open GLB file
        </a>
      )}
    </div>
  );
}
