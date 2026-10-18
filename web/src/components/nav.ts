import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Brain,
  Database,
  Network,
  Search,
  Settings,
  Share2,
  SquareTerminal,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: Activity, description: 'Node health and activity' },
  { to: '/cluster', label: 'Cluster', icon: Network, description: 'Nodes, ranges and placement' },
  { to: '/memory', label: 'Memory', icon: Brain, description: 'What agents remembered' },
  { to: '/recall', label: 'Recall', icon: Search, description: 'Try recall with its scores' },
  { to: '/graph', label: 'Graph', icon: Share2, description: 'Entities and relations' },
  { to: '/data', label: 'Data', icon: Database, description: 'Browse and edit keys' },
  { to: '/console', label: 'Console', icon: SquareTerminal, description: 'Run Redis commands' },
  { to: '/settings', label: 'Settings', icon: Settings, description: 'Effective configuration' },
];
