import { lazy, Suspense } from 'react';
import ScanPage from './pages/ScanPage';

// The admin is a separate chunk: scanner visitors never download it.
const AdminPage = lazy(() => import('./pages/AdminPage'));

export default function App() {
  const path = window.location.pathname
    .replace(/\/+$/, '')
    .toLowerCase();

  if (path === '/admin') {
    return (
      <Suspense fallback={null}>
        <AdminPage />
      </Suspense>
    );
  }

  return <ScanPage />;
}
