import { useState, type FormEvent } from 'react';
import {
  createArtworkLayer,
  deleteArtworkLayer,
  listArtworkLayers,
  updateArtworkLayer,
} from '../../cms/layerService';
import {
  defaultLayerInput,
  LAYER_LIMITS,
  validateLayerInput,
  type LayerInput,
} from '../../cms/layerRules';
import { listMedia } from '../../cms/mediaService';
import type { ArtworkLayerWithMedia, Media } from '../../cms/types';
import { Badge, Field, MediaPreview, Notice } from '../components';
import { useAction, useAsync, type Navigate } from '../hooks';

type NumericField =
  | 'position_x'
  | 'position_y'
  | 'position_z'
  | 'scale'
  | 'rotation_x'
  | 'rotation_y'
  | 'rotation_z'
  | 'sort_order';

type LayerDraft = Omit<LayerInput, NumericField> & Record<NumericField, string>;

function toDraft(input: LayerInput): LayerDraft {
  return {
    ...input,
    position_x: String(input.position_x),
    position_y: String(input.position_y),
    position_z: String(input.position_z),
    scale: String(input.scale),
    rotation_x: String(input.rotation_x),
    rotation_y: String(input.rotation_y),
    rotation_z: String(input.rotation_z),
    sort_order: String(input.sort_order),
  };
}

function toInput(draft: LayerDraft): LayerInput {
  const read = (field: NumericField) => {
    const value = draft[field].trim();
    return value ? Number(value) : Number.NaN;
  };

  return {
    ...draft,
    position_x: read('position_x'),
    position_y: read('position_y'),
    position_z: read('position_z'),
    scale: read('scale'),
    rotation_x: read('rotation_x'),
    rotation_y: read('rotation_y'),
    rotation_z: read('rotation_z'),
    sort_order: read('sort_order'),
  };
}

function LayerForm({
  existing,
  defaultOrder,
  media,
  busy,
  onSave,
  onCancel,
}: {
  existing: ArtworkLayerWithMedia | null;
  defaultOrder: number;
  media: Media[];
  busy: boolean;
  onSave: (input: LayerInput, selectedMedia: Media | null) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<LayerDraft>(() =>
    toDraft(existing ?? defaultLayerInput('VIDEO', '', defaultOrder)),
  );
  const [problem, setProblem] = useState<string | null>(null);

  function change<K extends keyof LayerDraft>(key: K, value: LayerDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setProblem(null);
  }

  const available = media.filter(
    (item) => item.status === 'active' && item.type === draft.layer_type,
  );
  const previouslySelected = existing?.media &&
    existing.media.id === draft.media_id &&
    !available.some((item) => item.id === existing.media?.id)
      ? existing.media
      : null;
  const selectedMedia =
    media.find((item) => item.id === draft.media_id) ?? previouslySelected;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input = toInput(draft);
    const error = validateLayerInput(input, selectedMedia ?? null);

    if (error) {
      setProblem(error);
      return;
    }

    if (await onSave(input, selectedMedia ?? null)) {
      onCancel();
    }
  };

  return (
    <form className="admin-form admin-layer-form" onSubmit={(event) => void submit(event)}>
      <h3>{existing ? 'Edit content layer' : 'New content layer'}</h3>
      <div className="admin-form__columns">
        <Field label="Layer type">
          <select
            value={draft.layer_type}
            disabled={busy}
            onChange={(event) => {
              const type = event.target.value as LayerInput['layer_type'];
              setDraft((current) => ({
                ...current,
                layer_type: type,
                media_id: '',
                fit: type === 'VIDEO' ? 'target' : null,
              }));
              setProblem(null);
            }}
          >
            <option value="VIDEO">Video</option>
            <option value="MODEL_3D">3D model (GLB)</option>
          </select>
        </Field>
        <Field label="Media Library file">
          <select
            required
            value={draft.media_id}
            disabled={busy}
            onChange={(event) => change('media_id', event.target.value)}
          >
            <option value="">Select a file</option>
            {available.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.type === 'VIDEO' ? ` (${item.video_mode ?? 'mode missing'})` : ''}
              </option>
            ))}
            {previouslySelected && (
              <option value={previouslySelected.id} disabled>
                {previouslySelected.name} (unavailable; replace to save)
              </option>
            )}
          </select>
        </Field>
        <Field label="Layer order (0 first)">
          <input
            type="number"
            required
            min={0}
            step={1}
            value={draft.sort_order}
            disabled={busy}
            onChange={(event) => change('sort_order', event.target.value)}
          />
        </Field>
        <Field label={`Scale (${LAYER_LIMITS.scale.min}–${LAYER_LIMITS.scale.max})`}>
          <input
            type="number"
            required
            min={LAYER_LIMITS.scale.min}
            max={LAYER_LIMITS.scale.max}
            step="any"
            value={draft.scale}
            disabled={busy}
            onChange={(event) => change('scale', event.target.value)}
          />
        </Field>
        {draft.layer_type === 'VIDEO' && (
          <Field label="Video fit">
            <select
              value={draft.fit ?? 'target'}
              disabled={busy}
              onChange={(event) =>
                change('fit', event.target.value as 'target' | 'video')
              }
            >
              <option value="target">Stretch to trigger</option>
              <option value="video">Preserve video aspect ratio</option>
            </select>
          </Field>
        )}
      </div>

      <h3>Position (1 unit = trigger width)</h3>
      <div className="admin-layer-axis">
        {(['position_x', 'position_y', 'position_z'] as const).map((axis) => (
          <Field key={axis} label={`${axis.slice(-1).toUpperCase()} (${LAYER_LIMITS.position.min}–${LAYER_LIMITS.position.max})`}>
            <input
              type="number"
              required
              min={LAYER_LIMITS.position.min}
              max={LAYER_LIMITS.position.max}
              step="any"
              value={draft[axis]}
              disabled={busy}
              onChange={(event) => change(axis, event.target.value)}
            />
          </Field>
        ))}
      </div>

      {draft.layer_type === 'MODEL_3D' && (
        <>
          <h3>Rotation (degrees; X = 90 often stands a model upright)</h3>
          <div className="admin-layer-axis">
            {(['rotation_x', 'rotation_y', 'rotation_z'] as const).map((axis) => (
              <Field key={axis} label={`${axis.slice(-1).toUpperCase()} (${LAYER_LIMITS.rotation.min}–${LAYER_LIMITS.rotation.max})`}>
                <input
                  type="number"
                  required
                  min={LAYER_LIMITS.rotation.min}
                  max={LAYER_LIMITS.rotation.max}
                  step="any"
                  value={draft[axis]}
                  disabled={busy}
                  onChange={(event) => change(axis, event.target.value)}
                />
              </Field>
            ))}
          </div>
        </>
      )}

      <div className="admin-row">
        <label className="admin-layer-checkbox">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={busy}
            onChange={(event) => change('enabled', event.target.checked)}
          />
          Enabled
        </label>
        {draft.layer_type === 'VIDEO' && (
          <>
            <label className="admin-layer-checkbox">
              <input
                type="checkbox"
                checked={draft.loop}
                disabled={busy}
                onChange={(event) => change('loop', event.target.checked)}
              />
              Loop
            </label>
            <label className="admin-layer-checkbox">
              <input
                type="checkbox"
                checked={draft.muted}
                disabled={busy}
                onChange={(event) => change('muted', event.target.checked)}
              />
              Muted
            </label>
          </>
        )}
      </div>

      {problem && <Notice kind="error">{problem}</Notice>}
      <div className="admin-row">
        <button
          className="admin-button admin-button--primary"
          type="submit"
          disabled={busy || !draft.media_id}
        >
          {busy ? 'Saving...' : existing ? 'Save layer' : 'Add layer'}
        </button>
        <button className="admin-button" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Editing a layer changes only the working copy; compiled packs and published
// releases remain unchanged. The authenticated Pack Tester reads these rows.
export default function LayerEditor({
  artworkId,
  canEdit,
  navigate,
}: {
  artworkId: string;
  canEdit: boolean;
  navigate: Navigate;
}) {
  const layers = useAsync(() => listArtworkLayers(artworkId), artworkId);
  const library = useAsync(() => listMedia(), 'active-layer-media');
  const { busy, message, run } = useAction();
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);

  const rows = layers.data ?? [];
  const selectable = (library.data ?? []).filter(
    (item) => item.type === 'VIDEO' || item.type === 'MODEL_3D',
  );
  const editing = rows.find((row) => row.id === editingId) ?? null;
  const nextOrder = Math.max(-1, ...rows.map((row) => row.sort_order)) + 1;

  const save = (input: LayerInput, media: Media | null) =>
    run(async () => {
      if (editing) {
        await updateArtworkLayer(artworkId, editing.id, input, media);
      } else {
        await createArtworkLayer(artworkId, input, media);
      }
      layers.reload();
      return editing ? 'Layer updated.' : 'Layer added.';
    }, 'Saving content layer...');

  const remove = (row: ArtworkLayerWithMedia) => {
    if (!window.confirm('Delete this content layer? The media file will remain in the library.')) {
      return;
    }
    void run(async () => {
      await deleteArtworkLayer(artworkId, row.id);
      if (editingId === row.id) {
        setEditingId(null);
      }
      layers.reload();
      return 'Layer deleted. The media file was not deleted.';
    });
  };

  return (
    <div className="admin-layer-editor">
      <div className="admin-toolbar">
        <div>
          <h3>Content layers</h3>
          <p className="admin-small admin-muted">
            Add video or GLB overlays. Lower order numbers render first.
          </p>
        </div>
        {canEdit && editingId === null && (
          <button
            type="button"
            className="admin-button admin-button--primary admin-button--small"
            disabled={busy || library.loading || selectable.length === 0}
            onClick={() => setEditingId('new')}
          >
            Add layer
          </button>
        )}
      </div>
      <p className="admin-small admin-muted">
        Changes are saved to the working artwork, not published to the live scanner.
        Test them in Target Packs before publishing a release.
      </p>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {layers.error && <Notice kind="error">{layers.error}</Notice>}
      {library.error && <Notice kind="error">{library.error}</Notice>}
      {layers.loading && !layers.data && <p className="admin-muted">Loading layers...</p>}
      {canEdit && !library.loading && selectable.length === 0 && (
        <Notice kind="warn">
          No active videos or GLB models found.{' '}
          <button
            className="admin-button admin-button--small"
            type="button"
            onClick={() => navigate('media')}
          >
            Open Media Library
          </button>
        </Notice>
      )}

      {editingId === 'new' && (
        <LayerForm
          key="new"
          existing={null}
          defaultOrder={nextOrder}
          media={library.data ?? []}
          busy={busy}
          onSave={save}
          onCancel={() => setEditingId(null)}
        />
      )}

      <div className="admin-list">
        {rows.map((row) => (
          <div key={row.id} className="admin-layer-item">
            <div className="admin-item admin-item--with-thumb">
              <MediaPreview media={row.media} thumb />
              <div>
                <div className="admin-item__title">
                  #{row.sort_order} {row.media?.name ?? 'Missing media'}
                  <Badge label={row.layer_type === 'VIDEO' ? 'Video' : '3D model'} />
                  {!row.enabled && <Badge label="disabled" />}
                  {row.media?.status === 'archived' && <Badge label="archived" />}
                </div>
                <p className="admin-small admin-muted">
                  Scale {row.scale}; position ({row.position_x}, {row.position_y}, {row.position_z})
                  {row.layer_type === 'VIDEO'
                    ? `; fit ${row.fit}; ${row.loop ? 'loop' : 'once'}; ${row.muted ? 'muted' : 'sound enabled'}`
                    : `; rotation (${row.rotation_x}, ${row.rotation_y}, ${row.rotation_z})`}
                </p>
              </div>
              {canEdit && (
                <div className="admin-row">
                  <button
                    className="admin-button admin-button--small"
                    type="button"
                    disabled={busy}
                    onClick={() => setEditingId((current) => current === row.id ? null : row.id)}
                  >
                    {editingId === row.id ? 'Close' : 'Edit'}
                  </button>
                  <button
                    className="admin-button admin-button--small"
                    type="button"
                    disabled={busy}
                    onClick={() => remove(row)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
            {editingId === row.id && (
              <LayerForm
                key={row.id}
                existing={editing ?? row}
                defaultOrder={row.sort_order}
                media={library.data ?? []}
                busy={busy}
                onSave={save}
                onCancel={() => setEditingId(null)}
              />
            )}
          </div>
        ))}
      </div>

      {layers.data && rows.length === 0 && (
        <p className="admin-small admin-muted">No layers yet. The artwork will track its image without an overlay.</p>
      )}
    </div>
  );
}
