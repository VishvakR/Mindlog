import type { LucideIcon } from 'lucide-react';
import { Activity, Database, Network, Settings, SquareTerminal } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: Activity, description: 'Node health and activity' },
  { to: '/cluster', label: 'Cluster', icon: Network, description: 'Nodes, ranges and placement' },
  { to: '/data', label: 'Data', icon: Database, description: 'Browse and edit keys' },
  { to: '/console', label: 'Console', icon: SquareTerminal, description: 'Run Redis commands' },
  { to: '/settings', label: 'Settings', icon: Settings, description: 'Effective configuration' },
];
