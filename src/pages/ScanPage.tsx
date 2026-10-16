import { useEffect, useState } from 'react';
import MindARViewer from '../ar/MindARViewer';
import type { ARProfile } from '../ar/types';
import { loadScannerProfile } from '../cms/releaseRuntime';

export default function ScanPage() {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; profile: ARProfile } | { kind: 'error'; message: string }
  >({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    void loadScannerProfile(window.location.search).then(
      (profile) => { if (active) setState({ kind: 'ready', profile }); },
      (error: unknown) => {
        if (active) setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not load this AR release.',
        });
      },
    );
    return () => { active = false; };
  }, []);

  if (state.kind === 'loading') {
    return <main className="scan-page" role="status">Loading AR experience...</main>;
  }
  if (state.kind === 'error') {
    return (
      <main className="scan-page" role="alert">
        <div style={{ padding: 24, color: 'white', fontFamily: 'sans-serif' }}>
          <h2>AR CONTENT UNAVAILABLE</h2>
          <p>{state.message}</p>
          <p>Preview links require a signed-in CMS account.</p>
        </div>
      </main>
    );
  }
  return <main className="scan-page"><MindARViewer profile={state.profile} /></main>;
}
