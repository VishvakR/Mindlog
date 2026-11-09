import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Access, Action, PolicyRow, Role } from '../src/index.js';
import { ACTIONS, ROLES, decide, matchesScope } from '../src/index.js';

const as = (role: Role, extra: Partial<Access> = {}): Access => ({
  role,
  tenant: 'a',
  subject: 'apikey:k1',
  ...extra,
});
const anyAction = fc.constantFrom<Action>(...ACTIONS);
const tenantRole = fc.constantFrom<Role>(...ROLES.filter((r) => r !== 'superuser'));
const anyRow: fc.Arbitrary<PolicyRow> = fc.record({
  effect: fc.constantFrom('allow' as const, 'deny' as const),
  subject: fc.constantFrom('agent', 'developer', 'readonly', 'tenant_admin', 'apikey:k1'),
  actions: fc.array(anyAction, { minLength: 1, maxLength: 5 }),
});
const allowAll = (subject: string): PolicyRow => ({
  effect: 'allow',
  subject,
  actions: [...ACTIONS],
});

describe('decide', () => {
  test('roles grant what PLAN 18.2 lists', () => {
    const r = { tenant: 'a', scope: 'u' };
    expect(decide(as('tenant_admin'), 'keys.manage', r).allow).toBe(true);
    expect(decide(as('tenant_admin'), 'tenant.delete', r).allow).toBe(false);
    expect(decide(as('developer'), 'kv.write', r).allow).toBe(true);
    expect(decide(as('developer'), 'policies.manage', r).allow).toBe(false);
    expect(decide(as('agent'), 'memory.write', r).allow).toBe(true);
    expect(decide(as('agent'), 'kv.read', r).allow).toBe(false);
    expect(decide(as('readonly'), 'memory.read', r).allow).toBe(true);
    expect(decide(as('readonly'), 'memory.write', r).allow).toBe(false);
    expect(decide(as('app_user'), 'memory.read', r).allow).toBe(false);
  });

  test('a policy row can grant an agent KV but not administration', () => {
    const r = { tenant: 'a' };
    expect(decide(as('agent'), 'kv.read', r, [allowAll('agent')]).allow).toBe(true);
    expect(decide(as('agent'), 'keys.manage', r, [allowAll('agent')]).allow).toBe(false);
  });

  test('a deny row beats the role and an allow row', () => {
    const r = { tenant: 'a', scope: 'u' };
    const rows: PolicyRow[] = [
      allowAll('developer'),
      { effect: 'deny', subject: 'apikey:k1', actions: ['memory.write'] },
    ];
    expect(decide(as('developer'), 'memory.write', r, rows).allow).toBe(false);
  });

  test('user pins and scope patterns limit memory only', () => {
    expect(
      decide(as('agent', { user: 'u' }), 'memory.read', { tenant: 'a', scope: 'u' }).allow,
    ).toBe(true);
    expect(
      decide(as('agent', { user: 'u' }), 'memory.read', { tenant: 'a', scope: 'v' }).allow,
    ).toBe(false);
    expect(decide(as('agent', { user: 'u' }), 'memory.read', { tenant: 'a' }).allow).toBe(false);
    const scoped = as('developer', { scopes: ['team-*'] });
    expect(decide(scoped, 'memory.read', { tenant: 'a', scope: 'team-1' }).allow).toBe(true);
    expect(decide(scoped, 'memory.read', { tenant: 'a', scope: 'solo' }).allow).toBe(false);
    expect(decide(scoped, 'kv.read', { tenant: 'a' }).allow).toBe(true);
  });

  test('every decision says why', () => {
    fc.assert(
      fc.property(tenantRole, anyAction, (role, action) => {
        expect(decide(as(role), action, { tenant: 'a', scope: 'u' }).reason).not.toBe('');
      }),
    );
  });

  test('nobody but a superuser crosses a tenant, whatever the rows say', () => {
    fc.assert(
      fc.property(tenantRole, anyAction, fc.array(anyRow), (role, action, rows) => {
        expect(decide(as(role), action, { tenant: 'b', scope: 'u' }, rows).allow).toBe(false);
      }),
    );
  });

  test('reserved tenants are refused even to superusers', () => {
    fc.assert(
      fc.property(anyAction, (action) => {
        expect(
          decide({ role: 'superuser', subject: 's' }, action, { tenant: '$system' }).allow,
        ).toBe(false);
      }),
    );
  });

  test('superuser-only actions stay superuser-only, whatever the rows say', () => {
    const only: Action[] = [
      'tenant.quotas',
      'tenant.create',
      'tenant.delete',
      'cluster.read',
      'cluster.admin',
    ];
    fc.assert(
      fc.property(tenantRole, fc.constantFrom(...only), fc.array(anyRow), (role, action, rows) => {
        expect(decide(as(role), action, { tenant: 'a' }, rows).allow).toBe(false);
      }),
    );
  });
});

test('matchesScope treats only a trailing star as a wildcard', () => {
  expect(matchesScope('*', 'x')).toBe(true);
  expect(matchesScope('a*', 'ab')).toBe(true);
  expect(matchesScope('a', 'ab')).toBe(false);
  expect(matchesScope('*b', 'ab')).toBe(false);
});
