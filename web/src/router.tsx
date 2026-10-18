import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { AppShell } from '@/components/app-shell';
import { session } from '@/lib/api';
import { ClusterPage } from '@/pages/cluster-page';
import { ConsolePage } from '@/pages/console-page';
import { DataPage } from '@/pages/data-page';
import { GraphPage } from '@/pages/graph-page';
import { LoginPage } from '@/pages/login-page';
import { MemoryPage } from '@/pages/memory-page';
import { OverviewPage } from '@/pages/overview-page';
import { RecallPage } from '@/pages/recall-page';
import { SettingsPage } from '@/pages/settings-page';

/** Pages behind login; the token is checked by the API on every call. */
function RequireSession() {
  return session.token() ? <Outlet /> : <Navigate to="/login" replace />;
}

export const router = createBrowserRouter(
  [
    { path: '/login', element: <LoginPage /> },
    {
      element: <RequireSession />,
      children: [
        {
          element: <AppShell />,
          children: [
            { index: true, element: <OverviewPage /> },
            { path: 'cluster', element: <ClusterPage /> },
            { path: 'memory', element: <MemoryPage /> },
            { path: 'recall', element: <RecallPage /> },
            { path: 'graph', element: <GraphPage /> },
            { path: 'data', element: <DataPage /> },
            { path: 'console', element: <ConsolePage /> },
            { path: 'settings', element: <SettingsPage /> },
          ],
        },
      ],
    },
    { path: '*', element: <Navigate to="/" replace /> },
  ],
  { basename: '/_' },
);
