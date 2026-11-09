import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { AppShell } from '@/components/app-shell';
import { session } from '@/lib/api';
import { AuditPage } from '@/pages/audit-page';
import { BranchesPage } from '@/pages/branches-page';
import { ClusterPage } from '@/pages/cluster-page';
import { CollectionsPage } from '@/pages/collections-page';
import { ConflictsPage } from '@/pages/conflicts-page';
import { ConsolePage } from '@/pages/console-page';
import { DataPage } from '@/pages/data-page';
import { GraphPage } from '@/pages/graph-page';
import { JobsPage } from '@/pages/jobs-page';
import { LivePage } from '@/pages/live-page';
import { LoginPage } from '@/pages/login-page';
import { MemoryPage } from '@/pages/memory-page';
import { OverviewPage } from '@/pages/overview-page';
import { RecallPage } from '@/pages/recall-page';
import { SettingsPage } from '@/pages/settings-page';
import { TenantsPage } from '@/pages/tenants-page';
import { TimeTravelPage } from '@/pages/time-travel-page';

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
            { path: 'conflicts', element: <ConflictsPage /> },
            { path: 'branches', element: <BranchesPage /> },
            { path: 'time-travel', element: <TimeTravelPage /> },
            { path: 'live', element: <LivePage /> },
            { path: 'jobs', element: <JobsPage /> },
            { path: 'collections', element: <CollectionsPage /> },
            { path: 'data', element: <DataPage /> },
            { path: 'tenants', element: <TenantsPage /> },
            { path: 'audit', element: <AuditPage /> },
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
