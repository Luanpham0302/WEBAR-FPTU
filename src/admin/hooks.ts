import { useCallback, useEffect, useState } from 'react';
import { describeError } from '../cms/errors';

export type SectionId =
  | 'dashboard'
  | 'campaigns'
  | 'artworks'
  | 'media'
  | 'packs'
  | 'releases'
  // Full-screen pack tester; not in the navigation.
  | 'test'
  | 'scanner';

const SECTIONS: readonly string[] = [
  'dashboard',
  'campaigns',
  'artworks',
  'media',
  'packs',
  'releases',
  'test',
  'scanner',
];

export type Route = {
  section: SectionId;
  // For example the campaign whose artworks are shown.
  param: string | null;
};

export type Navigate = (section: SectionId, param?: string) => void;

// "#/artworks/<campaign-id>". The hash keeps every section under /admin, so
// the app's path matching and the hosting redirects need no change.
function parseHash(hash: string): Route {
  const [section, param] = hash.replace(/^#\/?/, '').split('/');

  return {
    section: SECTIONS.includes(section) ? (section as SectionId) : 'dashboard',
    param: param ? decodeURIComponent(param) : null,
  };
}

export function useHashRoute(): [Route, Navigate] {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const handleChange = () => setRoute(parseHash(window.location.hash));

    window.addEventListener('hashchange', handleChange);

    return () => window.removeEventListener('hashchange', handleChange);
  }, []);

  const navigate = useCallback<Navigate>((section, param) => {
    window.location.hash = param
      ? `/${section}/${encodeURIComponent(param)}`
      : `/${section}`;
  }, []);

  return [route, navigate];
}

type AsyncState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

// Loads data when `key` changes and on reload(). The previous data stays on
// screen while a reload is running.
export function useAsync<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;

    setState((current) => ({ ...current, loading: true, error: null }));

    load().then(
      (data) => {
        if (active) {
          setState({ data, error: null, loading: false });
        }
      },
      (error: unknown) => {
        if (active) {
          setState({ data: null, error: describeError(error), loading: false });
        }
      },
    );

    return () => {
      active = false;
    };
    // `load` is a fresh closure on every render; `key` says when to re-run.
  }, [key, tick]);

  const reload = useCallback(() => setTick((current) => current + 1), []);

  return { ...state, reload };
}

// One action at a time, with a message for the result.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: 'good' | 'error' | 'warn';
    text: string;
  } | null>(null);

  const run = useCallback(
    async (action: () => Promise<string | void>, working?: string) => {
      setBusy(true);
      setMessage(working ? { kind: 'warn', text: working } : null);

      try {
        const done = await action();

        setMessage(done ? { kind: 'good', text: done } : null);
        return true;
      } catch (error) {
        console.error(error);
        setMessage({ kind: 'error', text: describeError(error) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { busy, message, setMessage, run };
}
