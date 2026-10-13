import { supabase } from '../lib/supabase';
import type { CmsRole } from './validation';

// 'not-installed': the Phase 2A migrations have not been applied to this
// Supabase project yet, so there is no role to read.
export type CmsAccess =
  | { state: 'ready'; role: CmsRole | null }
  | { state: 'not-installed' }
  | { state: 'error'; message: string };

const ROLES: readonly string[] = ['admin', 'editor', 'viewer'];

// PostgREST: function not found (PGRST202) or, on older versions, a plain
// 404 / undefined_function.
const FUNCTION_MISSING_CODES = new Set(['PGRST202', '42883']);

// Reads the role of the signed-in user. The database decides; a missing row
// means no CMS access.
export async function loadCmsAccess(): Promise<CmsAccess> {
  const { data, error } = await supabase.rpc('cms_role');

  if (error) {
    return FUNCTION_MISSING_CODES.has(error.code)
      ? { state: 'not-installed' }
      : { state: 'error', message: error.message };
  }

  return {
    state: 'ready',
    role: typeof data === 'string' && ROLES.includes(data) ? (data as CmsRole) : null,
  };
}
