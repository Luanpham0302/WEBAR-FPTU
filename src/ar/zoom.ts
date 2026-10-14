// Pinch-to-zoom for AR video layers.
//
// A zoom factor multiplies the scale a video layer is configured with
// (1 = as configured). Only the video plane is scaled: its position,
// rotation, aspect ratio, the MindAR anchor, the camera and the rest of the
// scene are untouched. Each artwork keeps its own factor for the whole camera
// session, so losing and regaining a target, or switching between targets,
// brings back the zoom that target had.
//
// No imports: this file also runs under `node --test`.

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_DEFAULT = 1;
// One press of + or - multiplies or divides by this.
export const ZOOM_STEP = 1.25;

export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) {
    return ZOOM_DEFAULT;
  }

  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor));
}

// The scale to give the video plane.
export function zoomedScale(baseScale: number, factor: number): number {
  return baseScale * clampZoom(factor);
}

export function zoomPercent(factor: number): number {
  return Math.round(clampZoom(factor) * 100);
}

export type Point = { x: number; y: number };

export function touchDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Fingers twice as far apart as when the pinch started = twice the zoom the
// target had when the pinch started.
export function pinchZoom(
  startZoom: number,
  startDistance: number,
  currentDistance: number,
): number {
  if (!(startDistance > 0) || !(currentDistance > 0)) {
    return clampZoom(startZoom);
  }

  return clampZoom(startZoom * (currentDistance / startDistance));
}

export function stepZoom(factor: number, direction: 1 | -1): number {
  const next = clampZoom(factor * ZOOM_STEP ** direction);

  // Stepping back and forth lands exactly on 100% instead of 99.99%.
  return Math.abs(next - ZOOM_DEFAULT) < 0.005 ? ZOOM_DEFAULT : next;
}

// Zoom state of one camera session.
//
// `apply(artworkId, factor)` is called whenever the factor of an artwork
// changes, so its video layers can be rescaled. The artwork manager also
// calls factorFor() when it (re)loads an artwork's layers.
export class ArtworkZoom {
  private readonly factors = new Map<string, number>();
  private readonly apply: (artworkId: string, factor: number) => void;
  private activeId: string | null = null;
  private pinch: { distance: number; zoom: number } | null = null;

  constructor(apply: (artworkId: string, factor: number) => void) {
    this.apply = apply;
  }

  factorFor(artworkId: string): number {
    return this.factors.get(artworkId) ?? ZOOM_DEFAULT;
  }

  // The artwork whose target is being tracked, or null. A change of target
  // ends any pinch in progress, so one target's pinch never spills onto
  // another.
  setActive(artworkId: string | null) {
    if (artworkId !== this.activeId) {
      this.pinch = null;
    }

    this.activeId = artworkId;
  }

  get active(): string | null {
    return this.activeId;
  }

  // Factor of the tracked artwork, or null when nothing is tracked.
  current(): number | null {
    return this.activeId === null ? null : this.factorFor(this.activeId);
  }

  // Sets the factor of the tracked artwork. Returns the factor that was
  // applied, or null when nothing is tracked.
  zoomTo(factor: number): number | null {
    if (this.activeId === null) {
      return null;
    }

    const next = clampZoom(factor);

    if (next === this.factorFor(this.activeId)) {
      return next;
    }

    if (next === ZOOM_DEFAULT) {
      this.factors.delete(this.activeId);
    } else {
      this.factors.set(this.activeId, next);
    }

    this.apply(this.activeId, next);
    return next;
  }

  step(direction: 1 | -1): number | null {
    const factor = this.current();

    return factor === null ? null : this.zoomTo(stepZoom(factor, direction));
  }

  reset(): number | null {
    return this.zoomTo(ZOOM_DEFAULT);
  }

  pinchStart(distance: number): boolean {
    const factor = this.current();

    if (factor === null || !(distance > 0)) {
      this.pinch = null;
      return false;
    }

    this.pinch = { distance, zoom: factor };
    return true;
  }

  pinchMove(distance: number): number | null {
    if (!this.pinch) {
      return null;
    }

    return this.zoomTo(pinchZoom(this.pinch.zoom, this.pinch.distance, distance));
  }

  pinchEnd() {
    this.pinch = null;
  }

  get pinching(): boolean {
    return this.pinch !== null;
  }
}
