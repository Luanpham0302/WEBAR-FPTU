// Which AR profile the public scanner shows. Pure: no imports, so it also
// runs under `node --test`.
//
//   ?profile=poc     the bundled PoC. Never a CMS request.
//   ?preview=<uuid>  a private preview. Any failure is shown; nothing else is
//                    displayed in its place.
//   otherwise        the published release. Only a failure to READ it
//                    (Supabase unreachable, RPC error) and "nothing is
//                    published" fall back to the legacy scanner. A published
//                    manifest that cannot be used is shown as an error, never
//                    silently replaced by other content.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ScannerSources<P> = {
  poc: P;
  legacy: P;
  fetchLive: () => Promise<unknown>;
  fetchPreview: (token: string) => Promise<unknown>;
  // Throws for any manifest it cannot turn into a profile.
  toProfile: (manifest: unknown) => P;
  onLiveUnavailable?: (error: unknown) => void;
};

export async function chooseScannerProfile<P>(search: string, sources: ScannerSources<P>): Promise<P> {
  const params = new URLSearchParams(search);

  if (params.get('profile') === 'poc') {
    return sources.poc;
  }

  const preview = params.get('preview');

  if (preview !== null) {
    if (!UUID.test(preview)) {
      throw new Error('Invalid preview token.');
    }
    return sources.toProfile(await sources.fetchPreview(preview));
  }

  let published: unknown;

  try {
    published = await sources.fetchLive();
  } catch (error) {
    sources.onLiveUnavailable?.(error);
    return sources.legacy;
  }

  // Outside the try: an error here is about the published manifest itself.
  return published === null || published === undefined
    ? sources.legacy
    : sources.toProfile(published);
}
