import ScanPage from './pages/ScanPage';
import AdminPage from './pages/AdminPage';

export default function App() {
  const path = window.location.pathname
    .replace(/\/+$/, '')
    .toLowerCase();

  if (path === '/admin') {
    return <AdminPage />;
  }

  return <ScanPage />;
}