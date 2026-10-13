// Pure helpers shared by the CMS forms. No imports: also runs under
// `node --test`.

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 64;

// "Áo Thun Hè 2026" -> "ao-thun-he-2026". Same rule as the database CHECK.
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, '');
}

export function isValidSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}

export type CmsRole = 'admin' | 'editor' | 'viewer';

const ROLE_RANK: Record<CmsRole, number> = { viewer: 1, editor: 2, admin: 3 };

// Mirrors public.cms_has_role(). The database enforces it; this only decides
// which buttons to show.
export function hasRole(role: CmsRole | null, minimum: CmsRole): boolean {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);

  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
