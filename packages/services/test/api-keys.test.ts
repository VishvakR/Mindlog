import { describe, expect, test } from 'vitest';
import { ApiKeyService, authorizeScope } from '@mindlog/services';
import { serviceNode } from './support/service-node.js';

async function setup() {
  const node = await serviceNode();
  return { node, keys: new ApiKeyService({ service: node.service, clock: node.clock }) };
}

describe('ApiKeyService', () => {
  test('a created key verifies to its tenant and user; the secret is shown once', async () => {
    const { keys } = await setup();
    const created = await keys.create({ tenant: 'acme', user: 'alice', name: 'claude desktop' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.key).toMatch(/^mlk_[A-Za-z0-9_-]{40,}$/);
    const verified = await keys.verify(created.value.key);
    expect(verified).toEqual({
      ok: true,
      value: {
        role: 'agent',
        id: created.value.id,
        tenant: 'acme',
        user: 'alice',
        name: 'claude desktop',
      },
    });
    const listed = await keys.list();
    expect(listed.ok && listed.value.map((k) => [k.id, k.tenant, k.user, k.name])).toEqual([
      [created.value.id, 'acme', 'alice', 'claude desktop'],
    ]);
    expect(JSON.stringify(listed)).not.toContain(created.value.key);
  });

  test('unknown, malformed and revoked keys are UNAUTHENTICATED', async () => {
    const { keys } = await setup();
    const created = await keys.create({ tenant: 'acme', name: 'ci' });
    if (!created.ok) throw new Error('create');
    for (const key of ['', 'nope', `${created.value.key}x`]) {
      const r = await keys.verify(key);
      expect(!r.ok && r.error.code).toBe('UNAUTHENTICATED');
    }
    expect(await keys.revoke(created.value.id)).toEqual({ ok: true, value: true });
    const r = await keys.verify(created.value.key);
    expect(!r.ok && r.error.code).toBe('UNAUTHENTICATED');
    expect(await keys.revoke(created.value.id)).toEqual({ ok: true, value: false });
  });

  test('keys live in the system tenant, invisible to RESP sessions', async () => {
    const { node, keys } = await setup();
    await keys.create({ tenant: 'default', name: 'x' });
    expect(await node.run(node.open(), 'KEYS', '*')).toEqual([]);
  });

  test('invalid input is INVALID_ARGUMENT', async () => {
    const { keys } = await setup();
    const r = await keys.create({ tenant: '', name: 'x' });
    expect(!r.ok && r.error.code).toBe('INVALID_ARGUMENT');
    const reserved = await keys.create({ tenant: '$system', name: 'x' });
    expect(!reserved.ok && reserved.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('authorizeScope (key × tenant × user × action)', () => {
  const tenantKey = { id: 'k1', tenant: 'acme', name: 'n', role: 'agent' as const };
  const userKey = { ...tenantKey, user: 'alice' };
  test.each([
    ['tenant key, any user of its tenant', tenantKey, 'bob', true],
    ['tenant key, tenant-wide scope', tenantKey, '', true],
    ['user key, its own user', userKey, 'alice', true],
    ['user key, another user', userKey, 'bob', false],
    ['user key, tenant-wide scope', userKey, '', false],
  ])('%s', (_name, key, user, allowed) => {
    const r = authorizeScope(key, user);
    expect(r.ok).toBe(allowed);
    if (!r.ok) expect(r.error.code).toBe('PERMISSION_DENIED');
  });
});
