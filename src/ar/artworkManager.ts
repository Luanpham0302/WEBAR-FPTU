import type { Group } from 'three';
import { createModelLayer } from './modelLayer';
import type {
  Artwork,
  ArtworkState,
  LayerConfig,
  LayerContext,
  LayerRuntime,
} from './types';
import { createVideoLayer } from './videoLayer';

// 'partial': some layers of the artwork failed, the rest are showing.
// 'error': nothing could be loaded for the artwork.
export type ActiveArtworkPhase = 'loading' | 'playing' | 'partial' | 'error';

export type ActiveArtworkInfo = {
  artwork: Artwork;
  phase: ActiveArtworkPhase;
};

type ArtworkManagerOptions = {
  // Loaded artworks kept in memory besides the current one. 0 keeps only the
  // current artwork and reloads every other one when it is found again.
  maxPaused: number;
  onActiveChange?: (info: ActiveArtworkInfo | null) => void;
  onSoundBlocked?: () => void;
};

function createLayer(
  config: LayerConfig,
  artwork: Artwork,
  context: LayerContext,
): Promise<LayerRuntime> {
  switch (config.type) {
    case 'VIDEO':
      return createVideoLayer(config, artwork, context);
    case 'MODEL_3D':
      return createModelLayer(config);
  }
}

type ArtworkEntry = {
  artwork: Artwork;
  group: Group;
  state: ArtworkState;
  layers: LayerRuntime[];
  loadToken: number;
  loadFailed: boolean;
  lastUsed: number;
};

export class ArtworkManager {
  private readonly entries = new Map<number, ArtworkEntry>();
  private readonly maxPaused: number;
  private readonly onActiveChange?: (info: ActiveArtworkInfo | null) => void;
  private readonly layerContext: LayerContext;
  private activeTargetIndex: number | null = null;
  private useCounter = 0;
  private soundEnabled = false;
  private disposed = false;

  constructor(options: ArtworkManagerOptions) {
    this.maxPaused = Math.max(0, options.maxPaused);
    this.onActiveChange = options.onActiveChange;
    this.layerContext = {
      isSoundEnabled: () => this.soundEnabled,
      onSoundBlocked: () => options.onSoundBlocked?.(),
    };
  }

  register(artwork: Artwork, group: Group) {
    this.entries.set(artwork.targetIndex, {
      artwork,
      group,
      state: 'UNLOADED',
      layers: [],
      loadToken: 0,
      loadFailed: false,
      lastUsed: 0,
    });
  }

  handleTargetFound(targetIndex: number) {
    const entry = this.entries.get(targetIndex);

    if (!entry || this.disposed) {
      return;
    }

    // MindAR can report the next target as found a few frames before it
    // reports the previous one as lost, so the latest found target wins.
    this.activeTargetIndex = targetIndex;
    entry.lastUsed = ++this.useCounter;

    this.entries.forEach((other) => {
      if (other !== entry && other.state === 'ACTIVE') {
        this.pauseEntry(other);
      }
    });

    if (entry.state === 'UNLOADED' || entry.state === 'DISPOSED') {
      void this.loadEntry(entry);
    } else if (entry.state === 'PAUSED') {
      this.activateEntry(entry);
    }

    this.enforceMemoryPolicy();
    this.notify();
  }

  handleTargetLost(targetIndex: number) {
    const entry = this.entries.get(targetIndex);

    if (!entry || this.disposed) {
      return;
    }

    if (entry.state === 'ACTIVE') {
      this.pauseEntry(entry);
    }

    if (this.activeTargetIndex === targetIndex) {
      this.activeTargetIndex = null;
      this.notify();
    }
  }

  // Call from a user gesture so the browser allows the change to take effect.
  setSoundEnabled(enabled: boolean) {
    this.soundEnabled = enabled;
    this.resumeActive();
  }

  resumeActive() {
    this.getActiveEntry()?.layers.forEach((layer) => layer.resume());
  }

  update(deltaSeconds: number) {
    this.getActiveEntry()?.layers.forEach((layer) =>
      layer.update(deltaSeconds),
    );
  }

  dispose() {
    this.disposed = true;
    this.activeTargetIndex = null;
    this.entries.forEach((entry) => this.disposeEntry(entry));
  }

  private async loadEntry(entry: ArtworkEntry) {
    const token = ++entry.loadToken;
    entry.state = 'LOADING';
    entry.loadFailed = false;

    // Layers load independently so one broken file cannot block the others.
    const results = await Promise.allSettled(
      entry.artwork.layers.map((layer) =>
        createLayer(layer, entry.artwork, this.layerContext),
      ),
    );

    const layers: LayerRuntime[] = [];
    let failed = false;

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        layers.push(result.value);
        return;
      }

      failed = true;
      console.error(
        `Could not load ${entry.artwork.layers[index].src}`,
        result.reason,
      );
    });

    if (this.disposed || entry.loadToken !== token) {
      layers.forEach((layer) => layer.dispose());
      return;
    }

    entry.loadFailed = failed;

    if (layers.length === 0) {
      // Nothing to show; the next time the target is found it loads again.
      entry.state = 'DISPOSED';
      this.notify();
      return;
    }

    entry.layers = layers;
    layers.forEach((layer) => entry.group.add(layer.object3D));
    entry.state = 'READY';

    if (this.activeTargetIndex === entry.artwork.targetIndex) {
      this.activateEntry(entry);
    } else {
      entry.state = 'PAUSED';
    }

    this.enforceMemoryPolicy();
    this.notify();
  }

  private getActiveEntry() {
    if (this.activeTargetIndex === null) {
      return undefined;
    }

    const entry = this.entries.get(this.activeTargetIndex);

    return entry?.state === 'ACTIVE' ? entry : undefined;
  }

  private activateEntry(entry: ArtworkEntry) {
    entry.state = 'ACTIVE';
    entry.layers.forEach((layer) => layer.activate());
  }

  private pauseEntry(entry: ArtworkEntry) {
    entry.state = 'PAUSED';
    entry.layers.forEach((layer) => layer.pause());
  }

  private disposeEntry(entry: ArtworkEntry) {
    // Invalidates a load that is still in flight.
    entry.loadToken += 1;
    entry.layers.forEach((layer) => layer.dispose());
    entry.layers = [];
    entry.state = 'DISPOSED';
  }

  // Keeps the current artwork (playing, or the last one that was) plus
  // maxPaused older ones, and frees everything else. Loads in flight count,
  // so an old artwork is freed before the new one finishes loading.
  private enforceMemoryPolicy() {
    const loaded = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.state === 'ACTIVE' ||
          entry.state === 'PAUSED' ||
          entry.state === 'LOADING',
      )
      .sort((a, b) => b.lastUsed - a.lastUsed);

    loaded
      .slice(1 + this.maxPaused)
      .forEach((entry) => this.disposeEntry(entry));
  }

  private notify() {
    if (!this.onActiveChange) {
      return;
    }

    const entry =
      this.activeTargetIndex === null
        ? undefined
        : this.entries.get(this.activeTargetIndex);

    if (!entry) {
      this.onActiveChange(null);
      return;
    }

    let phase: ActiveArtworkPhase = 'playing';

    if (entry.state === 'LOADING') {
      phase = 'loading';
    } else if (entry.loadFailed) {
      phase = entry.layers.length > 0 ? 'partial' : 'error';
    }

    this.onActiveChange({ artwork: entry.artwork, phase });
  }
}
