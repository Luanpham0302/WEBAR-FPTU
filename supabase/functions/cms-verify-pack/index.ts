// Supabase Edge Function: independently verify a stored MindAR target pack.
// IMPORTANT: verify_jwt=false in config.toml only bypasses the API gateway;
// this handler validates a real Supabase user JWT and their CMS role itself.
import { createClient } from 'npm:@supabase/supabase-js@2.117.0';
import { decode } from 'npm:@msgpack/msgpack@2.8.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;

function reply(status: number, message: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ message, ...extra }), { status, headers: cors });
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function isPositiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, 'Method not allowed.');

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return reply(503, 'Trusted verifier is not configured.');

  // No user-supplied URL, bucket, bytes or SHA is accepted.
  const jwt = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!jwt) return reply(401, 'Sign in to the CMS first.');

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: authData, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !authData.user) return reply(401, 'Invalid or expired CMS session.');

  const { data: access, error: accessError } = await admin
    .from('user_roles').select('role').eq('user_id', authData.user.id).maybeSingle();
  if (accessError) return reply(500, 'Could not check CMS access.');
  if (access?.role !== 'admin' && access?.role !== 'editor') {
    return reply(403, 'Only an Editor or Admin may verify target pack contents.');
  }

  let body: Record<string, unknown> | null;
  try {
    const raw = await req.text();
    if (raw.length > 1000) return reply(400, 'Request is too large.');
    body = object(JSON.parse(raw));
  } catch {
    return reply(400, 'Send a JSON request with packId.');
  }
  const packId = body?.packId;
  if (typeof packId !== 'string' || !uuid.test(packId)) {
    return reply(400, 'packId must be a UUID.');
  }

  const { data: pack, error: packError } = await admin
    .from('target_packs').select('*').eq('id', packId).maybeSingle();
  if (packError) return reply(500, 'Could not read target pack.');
  if (!pack) return reply(404, 'Target pack not found.');
  if (pack.status !== 'verified' || pack.compiler_version !== '1.2.5'
      || pack.storage_provider !== 'supabase' || pack.bucket !== 'ar-media'
      || !SHA.test(pack.sha256)
      || pack.storage_key !== 'targets/' + pack.campaign_id + '/v' + pack.version + '/targets.mind') {
    return reply(422, 'The pack is not an eligible MindAR 1.2.5 pack.');
  }

  const { data: items, error: itemsError } = await admin
    .from('target_pack_items').select('target_index,width,height')
    .eq('pack_id', pack.id).order('target_index');
  if (itemsError) return reply(500, 'Could not read frozen target mapping.');
  if (!items || items.length !== pack.target_count || pack.target_count < 1) {
    return reply(422, 'The target mapping is incomplete.');
  }

  const { data: blob, error: storageError } = await admin.storage
    .from(pack.bucket).download(pack.storage_key);
  if (storageError || !blob) return reply(422, 'The stored .mind file cannot be downloaded.');

  try {
    const bytes = await blob.arrayBuffer();
    if (bytes.byteLength !== pack.file_size || bytes.byteLength > 50 * 1024 * 1024) {
      return reply(422, 'The stored file size does not match the reservation.');
    }

    const rawHash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(rawHash)]
      .map((n) => n.toString(16).padStart(2, '0')).join('');
    if (sha256 !== pack.sha256) {
      return reply(422, 'The stored file SHA-256 does not match the reservation.');
    }

    const decoded = object(decode(new Uint8Array(bytes)));
    if (!decoded || decoded.v !== 2 || !Array.isArray(decoded.dataList)
        || decoded.dataList.length !== pack.target_count) {
      return reply(422, 'Invalid MindAR v2 target structure or target count.');
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const target = object(decoded.dataList[i]);
      const image = object(target?.targetImage);
      if (item.target_index !== i || !image
          || !isPositiveInt(image.width) || !isPositiveInt(image.height)
          || image.width !== item.width || image.height !== item.height
          || !Array.isArray(target?.matchingData)
          || !Array.isArray(target?.trackingData)
          || target.matchingData.length === 0 || target.trackingData.length === 0) {
        return reply(422, 'The embedded target at index ' + i + ' does not match its reserved mapping.');
      }
    }

    // Refetch status to refuse a concurrent retirement. The publishing RPC
    // repeats these checks under a transaction and row locks.
    const { data: current, error: currentError } = await admin
      .from('target_packs').select('status,sha256').eq('id', pack.id).single();
    if (currentError || current.status !== 'verified' || current.sha256 !== sha256) {
      return reply(409, 'Pack status changed during verification. Try again.');
    }

    const { error: writeError } = await admin.from('cms_trusted_pack_checks').upsert({
      pack_id: pack.id,
      sha256,
      verifier_version: 'mind-ar@1.2.5',
      verified_by: authData.user.id,
      verified_at: new Date().toISOString(),
    }, { onConflict: 'pack_id' });
    if (writeError) {
      console.error('Trusted verification write failed:', writeError.code);
      return reply(500, 'Could not record trusted verification. Apply Phase 2C.2 SQL first.');
    }
    return reply(200, 'Trusted verification passed.', { verified: true, targetCount: items.length });
  } catch (error) {
    console.error('MindAR verification error:', error instanceof Error ? error.message : 'unknown');
    return reply(422, 'The stored file is not a valid MindAR target pack.');
  }
});
