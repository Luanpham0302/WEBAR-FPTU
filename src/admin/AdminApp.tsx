import { useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { loadCmsAccess, type CmsAccess } from '../cms/accessService';
import { hasRole } from '../cms/validation';
import { supabase } from '../lib/supabase';
import { Badge, Field, Notice } from './components';
import { useHashRoute, type SectionId } from './hooks';
import ArtworksSection from './sections/ArtworksSection';
import CampaignsSection from './sections/CampaignsSection';
import DashboardSection from './sections/DashboardSection';
import MediaLibrarySection from './sections/MediaLibrarySection';
import PackTester from './sections/PackTester';
import ScannerSettingsSection from './sections/ScannerSettingsSection';
import TargetPacksSection from './sections/TargetPacksSection';
import './admin.css';

const NAV: { id: SectionId; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'artworks', label: 'Artworks' },
  { id: 'media', label: 'Media Library' },
  { id: 'packs', label: 'Target Packs' },
  { id: 'scanner', label: 'Scanner Settings' },
];

// Shown disabled so the shape of the CMS is visible before they exist.
const COMING_NEXT = ['Releases'];

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('Logging in...');

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    setBusy(false);
    setMessage(error ? error.message : '');
  };

  return (
    <div className="admin-center">
      <form className="admin-login" onSubmit={(event) => void login(event)}>
        <h1>AR SHIRT ADMIN</h1>
        <Field label="Email">
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <button className="admin-button admin-button--primary" disabled={busy}>
          Login
        </button>
        {message && <p>{message}</p>}
      </form>
    </div>
  );
}

export default function AdminApp() {
  // undefined: the stored session has not been read yet.
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [access, setAccess] = useState<CmsAccess | null>(null);
  const [route, navigate] = useHashRoute();

  useEffect(() => {
    void supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;

  useEffect(() => {
    setAccess(null);

    if (!userId) {
      return;
    }

    let active = true;

    void loadCmsAccess().then((result) => {
      if (active) {
        setAccess(result);
      }
    });

    return () => {
      active = false;
    };
  }, [userId]);

  if (session === undefined) {
    return (
      <div className="admin">
        <div className="admin-center">Loading...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="admin">
        <LoginForm />
      </div>
    );
  }

  const role = access?.state === 'ready' ? access.role : null;
  // Before the CMS database exists there are no roles to check, and Scanner
  // Settings keeps working exactly as it did, under the existing policies.
  const legacyMode = access?.state === 'not-installed';

  const renderSection = () => {
    if (!access) {
      return <p className="admin-muted">Checking access...</p>;
    }

    if (access.state === 'error') {
      return (
        <Notice kind="error">Could not check your access: {access.message}</Notice>
      );
    }

    if (route.section === 'scanner' && (legacyMode || role)) {
      return (
        <ScannerSettingsSection
          canUpload={legacyMode || hasRole(role, 'editor')}
          canPublish={legacyMode || hasRole(role, 'admin')}
        />
      );
    }

    if (legacyMode) {
      return (
        <Notice kind="warn">
          The CMS database is not installed on this Supabase project yet. Apply
          the migrations in <span className="admin-mono">supabase/migrations/</span>,
          then create the first Admin. Scanner Settings works in the meantime.
        </Notice>
      );
    }

    if (!role) {
      return (
        <Notice kind="warn">
          This account has no CMS role, so there is nothing to show. Ask an
          Admin to give you access.
        </Notice>
      );
    }

    switch (route.section) {
      case 'campaigns':
        return <CampaignsSection role={role} navigate={navigate} />;
      case 'artworks':
        return (
          <ArtworksSection
            role={role}
            campaignId={route.param}
            navigate={navigate}
          />
        );
      case 'media':
        return <MediaLibrarySection role={role} />;
      case 'packs':
        return (
          <TargetPacksSection
            role={role}
            campaignId={route.param}
            navigate={navigate}
          />
        );
      default:
        return <DashboardSection role={role} navigate={navigate} />;
    }
  };

  // The tester takes the whole screen for the camera. It needs a CMS role:
  // the pack and its artworks are read through row level security.
  if (route.section === 'test' && role && route.param) {
    return (
      <PackTester
        packId={route.param}
        onExit={(campaignId) => navigate('packs', campaignId ?? undefined)}
      />
    );
  }

  return (
    <div className="admin">
      <header className="admin-header">
        <div className="admin-header__bar">
          <h1>AR SHIRT CONTENT MANAGER</h1>
          <div className="admin-header__user">
            <span className="admin-header__email admin-small admin-muted">
              {session.user.email}
            </span>
            {role && <Badge label={role} />}
            <button
              className="admin-button admin-button--small"
              type="button"
              onClick={() => void supabase.auth.signOut()}
            >
              Logout
            </button>
          </div>
        </div>
        <nav className="admin-nav" aria-label="Admin sections">
          {NAV.map((item) => (
            <button
              key={item.id}
              className="admin-nav__item"
              type="button"
              aria-current={route.section === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              {item.label}
            </button>
          ))}
          {COMING_NEXT.map((label) => (
            <button
              key={label}
              className="admin-nav__item"
              type="button"
              disabled
              title="Coming in a later phase"
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="admin-main">{renderSection()}</main>
    </div>
  );
}
