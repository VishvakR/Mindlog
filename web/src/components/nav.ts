import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Boxes,
  Brain,
  Database,
  GitBranch,
  History,
  ListChecks,
  Radio,
  Scale,
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
  { to: '/conflicts', label: 'Conflicts', icon: Scale, description: 'Contradictions to resolve' },
  { to: '/branches', label: 'Branches', icon: GitBranch, description: 'Diff, merge or drop plans' },
  { to: '/time-travel', label: 'Time travel', icon: History, description: 'Memory as it was' },
  { to: '/live', label: 'Live feed', icon: Radio, description: 'Changes as they commit' },
  { to: '/jobs', label: 'Jobs', icon: ListChecks, description: 'Consolidation and forgetting' },
  {
    to: '/collections',
    label: 'Collections',
    icon: Boxes,
    description: 'App data, rules and users',
  },
  { to: '/data', label: 'Data', icon: Database, description: 'Browse and edit keys' },
  { to: '/console', label: 'Console', icon: SquareTerminal, description: 'Run Redis commands' },
  { to: '/settings', label: 'Settings', icon: Settings, description: 'Effective configuration' },
];
