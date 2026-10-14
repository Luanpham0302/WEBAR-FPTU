// What makes an image acceptable as a MindAR trigger. Pure: no imports, so
// it also runs under `node --test`.
//
// Errors block the upload and the compile. Warnings are shown and allowed.
// The limits are practical ones for this project, not MindAR constants:
// MindAR itself accepts any image and simply tracks a poor one badly.

export const TRIGGER_RULES = {
  mimeTypes: ['image/png', 'image/jpeg'],
  // Shorter side, in pixels.
  minSide: 256,
  recommendedMinSide: 512,
  // Longer side, in pixels. Above the recommendation the compile gets slow
  // and the pack gets large without tracking any better.
  recommendedMaxSide: 4096,
  maxSide: 8192,
  // Longer side divided by shorter side.
  recommendedMaxAspect: 2.5,
  maxAspect: 4,
  // Same as the ar-sources bucket limit.
  maxBytes: 20 * 1024 * 1024,
} as const;

export type TriggerIssue = {
  level: 'error' | 'warning';
  code:
    | 'format'
    | 'file-size'
    | 'too-small'
    | 'small'
    | 'too-large'
    | 'large'
    | 'aspect-extreme'
    | 'aspect'
    | 'duplicate';
  message: string;
};

export type TriggerFacts = {
  mimeType: string;
  width: number;
  height: number;
  fileSize: number;
};

export function checkTriggerImage(facts: TriggerFacts): TriggerIssue[] {
  const issues: TriggerIssue[] = [];
  const rules = TRIGGER_RULES;
  const shorter = Math.min(facts.width, facts.height);
  const longer = Math.max(facts.width, facts.height);

  if (!rules.mimeTypes.includes(facts.mimeType as (typeof rules.mimeTypes)[number])) {
    issues.push({
      level: 'error',
      code: 'format',
      message: 'A trigger image must be a PNG or JPEG file.',
    });
  }

  if (facts.fileSize > rules.maxBytes) {
    issues.push({
      level: 'error',
      code: 'file-size',
      message: 'The file is larger than 20 MB.',
    });
  }

  if (!(shorter > 0)) {
    issues.push({
      level: 'error',
      code: 'too-small',
      message: 'The image size could not be read.',
    });
    return issues;
  }

  if (shorter < rules.minSide) {
    issues.push({
      level: 'error',
      code: 'too-small',
      message: `The image is ${facts.width} x ${facts.height} px. The shorter side must be at least ${rules.minSide} px.`,
    });
  } else if (shorter < rules.recommendedMinSide) {
    issues.push({
      level: 'warning',
      code: 'small',
      message: `The image is small. Tracking is more reliable when the shorter side is at least ${rules.recommendedMinSide} px.`,
    });
  }

  if (longer > rules.maxSide) {
    issues.push({
      level: 'error',
      code: 'too-large',
      message: `The image is ${facts.width} x ${facts.height} px. The longer side must be at most ${rules.maxSide} px.`,
    });
  } else if (longer > rules.recommendedMaxSide) {
    issues.push({
      level: 'warning',
      code: 'large',
      message: `The image is very large. Above ${rules.recommendedMaxSide} px the compile is slow and tracking does not improve.`,
    });
  }

  const aspect = longer / shorter;

  if (aspect > rules.maxAspect) {
    issues.push({
      level: 'error',
      code: 'aspect-extreme',
      message: `The image is too elongated (${aspect.toFixed(1)}:1). The longer side may be at most ${rules.maxAspect} times the shorter side.`,
    });
  } else if (aspect > rules.recommendedMaxAspect) {
    issues.push({
      level: 'warning',
      code: 'aspect',
      message: `The image is elongated (${aspect.toFixed(1)}:1). Shapes closer to a square or a page track more reliably.`,
    });
  }

  return issues;
}

export const hasBlockingIssue = (issues: TriggerIssue[]) =>
  issues.some((issue) => issue.level === 'error');

type TriggerOwner = {
  id: string;
  name: string;
  status: string;
  trigger_sha256: string | null;
};

// The other artwork of the campaign that already uses this exact image.
// MindAR cannot tell two identical triggers apart. Archived artworks are
// ignored: they are never compiled.
export function findDuplicateTrigger<T extends TriggerOwner>(
  sha256: string,
  artworkId: string,
  campaignArtworks: T[],
): T | null {
  return (
    campaignArtworks.find(
      (artwork) =>
        artwork.id !== artworkId &&
        artwork.status !== 'archived' &&
        artwork.trigger_sha256 === sha256,
    ) ?? null
  );
}

export const duplicateIssue = (ownerName: string): TriggerIssue => ({
  level: 'error',
  code: 'duplicate',
  message: `This exact image is already the trigger of "${ownerName}". Two artworks cannot share a trigger.`,
});
