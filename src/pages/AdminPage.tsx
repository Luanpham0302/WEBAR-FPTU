import {
  useEffect,
  useState,
  type ChangeEvent,
} from 'react';

import type { Session } from '@supabase/supabase-js';

import { supabase } from '../lib/supabase';

import {
  DEFAULT_AR_CONTENT,
  getARContent,
  saveARContent,
  uploadARAsset,
  type ARContentConfig,
} from '../lib/contentService';

type Field = {
  key: keyof ARContentConfig;
  label: string;
  accept: string;
};

const fields: Field[] = [
  {
    key: 'scannerBorder',
    label: 'Scanner Border',
    accept: 'image/*',
  },
  {
    key: 'scannerTitle',
    label: 'AR Scanner Title',
    accept: 'image/*',
  },
  {
    key: 'scannerFrame',
    label: 'Scanner Frame',
    accept: 'image/*',
  },
  {
    key: 'scannerBottom',
    label: 'Bottom Decoration',
    accept: 'image/*',
  },
  {
    key: 'loadingAnimation',
    label: 'Loading Animation',
    accept: 'video/*',
  },
  {
    key: 'animation01',
    label: 'AR Video 01',
    accept: 'video/*',
  },
  {
    key: 'animation02',
    label: 'AR Video 02',
    accept: 'video/*',
  },
  {
    key: 'animation03',
    label: 'AR Video 03',
    accept: 'video/*',
  },
];

function isVideo(key: keyof ARContentConfig) {
  return (
    key === 'loadingAnimation' ||
    key === 'animation01' ||
    key === 'animation02' ||
    key === 'animation03'
  );
}

export default function AdminPage() {
  const [session, setSession] =
    useState<Session | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [config, setConfig] =
    useState<ARContentConfig>(DEFAULT_AR_CONTENT);

  const [message, setMessage] = useState('');
  const [uploading, setUploading] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      setSession(session);

      const currentConfig =
        await getARContent();

      setConfig(currentConfig);

      setLoading(false);
    };

    void init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      },
    );

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const login = async () => {
    setMessage('Logging in...');

    const { error } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage('Login successful!');
  };

  const logout = async () => {
    await supabase.auth.signOut();
  };

  const handleUpload = async (
    key: keyof ARContentConfig,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];

    if (!file) return;

    try {
      setUploading(key);
      setMessage(`Uploading ${file.name}...`);

      const url = await uploadARAsset(
        key,
        file,
      );

      setConfig((old) => ({
        ...old,
        [key]: url,
      }));

      setMessage(
        'Upload thành công. Nhấn Publish để áp dụng.',
      );
    } catch (error) {
      console.error(error);

      setMessage(
        error instanceof Error
          ? error.message
          : 'Upload failed.',
      );
    } finally {
      setUploading(null);
    }
  };

  const publish = async () => {
    try {
      setMessage('Publishing...');

      await saveARContent(config);

      setMessage('Publish thành công!');
    } catch (error) {
      console.error(error);

      setMessage(
        error instanceof Error
          ? error.message
          : 'Publish failed.',
      );
    }
  };

  if (loading) {
    return <h2>Loading...</h2>;
  }

  if (!session) {
    return (
      <main
        style={{
          height: '100%',
          overflowY: 'auto',
          background: '#111',
          color: 'white',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <div
          style={{
            width: 350,
            display: 'grid',
            gap: 12,
          }}
        >
          <h1>AR SHIRT ADMIN</h1>

          <input
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) =>
              setEmail(e.target.value)
            }
          />

          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) =>
              setPassword(e.target.value)
            }
          />

          <button
            onClick={() => void login()}
          >
            Login
          </button>

          <p>{message}</p>
        </div>
      </main>
    );
  }

  return (
    <main
      style={{
        height: '100%',
        overflowY: 'auto',
        background: '#111',
        color: 'white',
        padding: 30,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div>
          <h1>AR SHIRT CONTENT MANAGER</h1>
          <p>
            Upload frame và video trực tiếp.
          </p>
        </div>

        <button
          onClick={() => void logout()}
        >
          Logout
        </button>
      </div>

      <hr />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 20,
        }}
      >
        {fields.map((field) => (
          <div
            key={field.key}
            style={{
              border: '1px solid #444',
              padding: 16,
              borderRadius: 12,
            }}
          >
            <h3>{field.label}</h3>

            <div
              style={{
                height: 220,
                background: '#222',
                display: 'grid',
                gridTemplateRows: 'minmax(0, 1fr)',
                placeItems: 'center',
                overflow: 'hidden',
                marginBottom: 12,
              }}
            >
              {isVideo(field.key) ? (
                <video
                  src={config[field.key]}
                  controls
                  muted
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                  }}
                />
              ) : (
                <img
                  src={config[field.key]}
                  alt=""
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                  }}
                />
              )}
            </div>

            <input
              type="file"
              accept={field.accept}
              disabled={uploading !== null}
              onChange={(event) =>
                void handleUpload(
                  field.key,
                  event,
                )
              }
            />

            {uploading === field.key && (
              <p>Uploading...</p>
            )}
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 30,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
        }}
      >
        <button
          onClick={() => void publish()}
          style={{
            padding: '12px 30px',
            fontWeight: 'bold',
          }}
        >
          Publish Changes
        </button>

        <button
          onClick={() =>
            setConfig(DEFAULT_AR_CONTENT)
          }
        >
          Reset to Default
        </button>

        <span>{message}</span>
      </div>
    </main>
  );
}