import { useState, type FormEvent } from 'react';
import type { VideoMode } from '../../ar/types';
import {
  checkFileForType,
  listMedia,
  updateMedia,
  uploadLibraryMedia,
} from '../../cms/mediaService';
import type { LibraryMediaType, Media, MediaType } from '../../cms/types';
import {
  formatBytes,
  formatDuration,
  hasRole,
  type CmsRole,
} from '../../cms/validation';
import { Badge, Field, MediaPreview, Notice } from '../components';
import { useAction, useAsync } from '../hooks';

const TYPE_LABEL: Record<MediaType, string> = {
  VIDEO: 'Video',
  MODEL_3D: '3D model',
  IMAGE: 'Image',
  TRIGGER: 'Trigger',
};

const ACCEPT: Record<LibraryMediaType, string> = {
  VIDEO: 'video/*',
  MODEL_3D: '.glb,model/gltf-binary',
  IMAGE: 'image/*',
};

const FILTERS: (MediaType | 'ALL')[] = [
  'ALL',
  'VIDEO',
  'MODEL_3D',
  'IMAGE',
  'TRIGGER',
];

function UploadForm({
  busy,
  onUpload,
}: {
  busy: boolean;
  onUpload: (input: {
    file: File;
    type: LibraryMediaType;
    name: string;
    videoMode: VideoMode;
  }) => Promise<boolean>;
}) {
  const [type, setType] = useState<LibraryMediaType>('VIDEO');
  const [videoMode, setVideoMode] = useState<VideoMode>('normal');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  // Remounts the file input to clear it.
  const [inputKey, setInputKey] = useState(0);

  const problem = file ? checkFileForType(file, type) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (!file || problem) {
      return;
    }

    if (await onUpload({ file, type, name, videoMode })) {
      setFile(null);
      setName('');
      setInputKey((current) => current + 1);
    }
  };

  return (
    <form className="admin-panel admin-form" onSubmit={(event) => void submit(event)}>
      <h3>Upload media</h3>
      <div className="admin-form__columns">
        <Field label="Type">
          <select
            value={type}
            onChange={(event) => {
              setType(event.target.value as LibraryMediaType);
              setFile(null);
              setInputKey((current) => current + 1);
            }}
          >
            <option value="VIDEO">Video</option>
            <option value="MODEL_3D">3D model (GLB)</option>
            <option value="IMAGE">Image</option>
          </select>
        </Field>
        {type === 'VIDEO' && (
          <Field label="Video mode">
            <select
              value={videoMode}
              onChange={(event) => setVideoMode(event.target.value as VideoMode)}
            >
              <option value="normal">Normal</option>
              <option value="alpha-packed">
                Alpha-packed (colour left, alpha right)
              </option>
            </select>
          </Field>
        )}
        <Field label="Name (optional, defaults to the file name)">
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </div>
      <Field label="File">
        <input
          key={inputKey}
          type="file"
          accept={ACCEPT[type]}
          disabled={busy}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </Field>
      {problem && <Notice kind="warn">{problem}</Notice>}
      <p className="admin-small admin-muted">
        A stored file never changes. To replace one, upload the new file and
        archive the old one. Trigger images are uploaded from their artwork.
      </p>
      <div className="admin-row">
        <button
          className="admin-button admin-button--primary"
          disabled={busy || !file || Boolean(problem)}
        >
          {busy ? 'Uploading...' : 'Upload'}
        </button>
        {file && (
          <span className="admin-small admin-muted">
            {file.name}, {formatBytes(file.size)}
          </span>
        )}
      </div>
    </form>
  );
}

function describe(media: Media) {
  const facts = [TYPE_LABEL[media.type], formatBytes(media.file_size)];

  if (media.width && media.height) {
    facts.push(`${media.width} x ${media.height}`);
  }

  if (media.duration !== null) {
    facts.push(formatDuration(media.duration));
  }

  return facts.join(' · ');
}

export default function MediaLibrarySection({ role }: { role: CmsRole }) {
  const canEdit = hasRole(role, 'editor');
  const [filter, setFilter] = useState<MediaType | 'ALL'>('ALL');
  const [showArchived, setShowArchived] = useState(false);
  const { busy, message, run } = useAction();

  const media = useAsync(
    () =>
      listMedia({
        type: filter === 'ALL' ? undefined : filter,
        includeArchived: showArchived,
      }),
    `${filter}:${showArchived}`,
  );

  const upload = (input: Parameters<typeof uploadLibraryMedia>[0]) =>
    run(async () => {
      await uploadLibraryMedia(input);
      media.reload();
      return 'Media stored.';
    }, `Uploading ${input.file.name}...`);

  const change = (
    item: Media,
    changes: Parameters<typeof updateMedia>[1],
    done: string,
  ) =>
    void run(async () => {
      await updateMedia(item.id, changes);
      media.reload();
      return done;
    });

  const rename = (item: Media) => {
    const name = window.prompt('Name', item.name)?.trim();

    if (name && name !== item.name) {
      change(item, { name }, 'Renamed.');
    }
  };

  return (
    <>
      <div className="admin-toolbar">
        <h2>Media Library</h2>
        <label className="admin-row admin-small">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived
        </label>
      </div>

      {canEdit && <UploadForm busy={busy} onUpload={upload} />}

      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {media.error && <Notice kind="error">{media.error}</Notice>}

      <div className="admin-row" role="group" aria-label="Filter by type">
        {FILTERS.map((value) => (
          <button
            key={value}
            className={`admin-button admin-button--small${filter === value ? ' admin-button--primary' : ''}`}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === 'ALL' ? 'All' : TYPE_LABEL[value]}
          </button>
        ))}
      </div>

      <div className="admin-grid">
        {(media.data ?? []).map((item) => (
          <div
            key={item.id}
            className={`admin-panel${item.status === 'archived' ? ' admin-item--archived' : ''}`}
          >
            <MediaPreview media={item} />
            <div className="admin-item__title">
              {item.name}
              {item.status === 'archived' && <Badge label="archived" />}
              {item.bucket === 'ar-sources' && <Badge label="private" />}
            </div>
            <div className="admin-small admin-muted">{describe(item)}</div>
            <div className="admin-mono admin-muted">{item.storage_key}</div>
            {item.type === 'VIDEO' && (
              <Field label="Video mode">
                <select
                  value={item.video_mode ?? 'normal'}
                  disabled={!canEdit || busy}
                  onChange={(event) =>
                    change(
                      item,
                      { video_mode: event.target.value as VideoMode },
                      'Video mode updated.',
                    )
                  }
                >
                  <option value="normal">Normal</option>
                  <option value="alpha-packed">Alpha-packed</option>
                </select>
              </Field>
            )}
            {canEdit && (
              <div className="admin-row">
                <button
                  className="admin-button admin-button--small"
                  type="button"
                  disabled={busy}
                  onClick={() => rename(item)}
                >
                  Rename
                </button>
                <button
                  className="admin-button admin-button--small"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    change(
                      item,
                      { status: item.status === 'active' ? 'archived' : 'active' },
                      item.status === 'active' ? 'Archived.' : 'Restored.',
                    )
                  }
                >
                  {item.status === 'active' ? 'Archive' : 'Restore'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {media.data && media.data.length === 0 && (
        <p className="admin-muted">Nothing here yet.</p>
      )}
      {media.loading && !media.data && <p className="admin-muted">Loading...</p>}
    </>
  );
}
