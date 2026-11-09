import { isUserTenant } from '@mindlog/core';

/** The roles of PLAN 18.2. */
export const ROLES = [
  'superuser',
  'tenant_admin',
  'developer',
  'agent',
  'app_user',
  'readonly',
] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  'memory.read',
  'memory.write',
  'kv.read',
  'kv.write',
  'collections.read',
  'collections.manage',
  'tenant.read',
  'tenant.settings',
  'keys.manage',
  'members.manage',
  'policies.manage',
  'audit.read',
  'data.export',
  'tenant.quotas',
  'tenant.create',
  'tenant.delete',
  'cluster.read',
  'cluster.admin',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Who is asking, reduced to what a decision needs. */
export interface Access {
  readonly role: Role;
  /** Absent only for superusers. */
  readonly tenant?: string;
  /** `Command.principal`, which policy rows can name. */
  readonly subject: string;
  /** Pins the caller to one user scope. */
  readonly user?: string;
  /** Scope patterns the caller is limited to (`alice`, `team-*`, `*`). */
  readonly scopes?: readonly string[];
}

export interface Resource {
  readonly tenant: string;
  /** The memory user scope, when the action targets one. */
  readonly scope?: string;
}

/** A replicated per-tenant policy row (PLAN 18.2): policies are data. */
export interface PolicyRow {
  readonly effect: 'allow' | 'deny';
  /** A role name or a principal such as `apikey:ab12`. */
  readonly subject: string;
  readonly actions: Action[];
  /** Limits the row to these scope patterns; absent means every scope. */
  readonly scopes?: string[];
}

export interface Decision {
  readonly allow: boolean;
  /** Why, for the audit log and the dashboard (CLAUDE.md principle 9). */
  readonly reason: string;
}

const SUPERUSER_ONLY: ReadonlySet<Action> = new Set([
  'tenant.quotas',
  'tenant.create',
  'tenant.delete',
  'cluster.read',
  'cluster.admin',
]);

/** Never granted to an agent, whatever a policy row says (CLAUDE.md §12). */
const ADMIN: ReadonlySet<Action> = new Set([
  ...SUPERUSER_ONLY,
  'collections.manage',
  'tenant.settings',
  'keys.manage',
  'members.manage',
  'policies.manage',
  'audit.read',
  'data.export',
]);

const READ: readonly Action[] = ['memory.read', 'kv.read', 'collections.read', 'tenant.read'];
const WRITE: readonly Action[] = ['memory.write', 'kv.write'];

const BUILT_IN: Readonly<Record<Exclude<Role, 'superuser'>, ReadonlySet<Action>>> = {
  tenant_admin: new Set([...READ, ...WRITE, ...ADMIN].filter((a) => !SUPERUSER_ONLY.has(a))),
  developer: new Set([...READ, ...WRITE]),
  agent: new Set(['memory.read', 'memory.write']),
  // End users reach data through collection rules only (PLAN 16.3).
  app_user: new Set(),
  readonly: new Set(READ),
};

/** `*` as the last character matches any suffix; anything else is literal. */
export function matchesScope(pattern: string, scope: string): boolean {
  return pattern.endsWith('*') ? scope.startsWith(pattern.slice(0, -1)) : pattern === scope;
}

const inScopes = (patterns: readonly string[] | undefined, scope: string | undefined): boolean =>
  patterns === undefined || (scope !== undefined && patterns.some((p) => matchesScope(p, scope)));

const memoryAction = (action: Action): boolean => action.startsWith('memory.');
const deny = (reason: string): Decision => ({ allow: false, reason });

/**
 * The authorization decision (PLAN 18.2): pure, and the only place roles,
 * tenants and policy rows are combined. A deny row beats an allow row, and no
 * row can cross a tenant, reach a reserved tenant, or give an agent an admin
 * action.
 */
export function decide(
  access: Access,
  action: Action,
  resource: Resource,
  policies: readonly PolicyRow[] = [],
): Decision {
  if (!isUserTenant(resource.tenant))
    return deny(`tenant ${resource.tenant} is reserved for the system`);
  if (access.role === 'superuser') return { allow: true, reason: 'superuser' };
  if (access.tenant !== resource.tenant)
    return deny(`caller belongs to tenant ${access.tenant ?? 'none'}, not ${resource.tenant}`);
  if (SUPERUSER_ONLY.has(action)) return deny(`${action} needs a superuser`);
  if (access.role === 'agent' && ADMIN.has(action)) return deny('agents never hold admin actions');
  if (memoryAction(action)) {
    if (access.user !== undefined && access.user !== resource.scope)
      return deny(`caller is limited to user ${access.user}`);
    if (!inScopes(access.scopes, resource.scope))
      return deny(`scope ${resource.scope ?? '(none)'} is outside the caller's scopes`);
  }
  const rows = policies.filter(
    (p) =>
      (p.subject === access.role || p.subject === access.subject) &&
      p.actions.includes(action) &&
      (!memoryAction(action) || inScopes(p.scopes, resource.scope)),
  );
  if (rows.some((p) => p.effect === 'deny')) return deny(`a policy denies ${action}`);
  if (BUILT_IN[access.role].has(action)) return { allow: true, reason: `role ${access.role}` };
  if (rows.length > 0) return { allow: true, reason: `a policy allows ${action}` };
  return deny(`role ${access.role} may not ${action}`);
}
