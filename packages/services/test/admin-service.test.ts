import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { AdminService } from '@mindlog/services';
import { serviceNode } from './support/service-node.js';

const creds = { email: 'Admin@Example.com', password: 'correct horse battery' };

async function setup() {
  const node = await serviceNode();
  return {
    node,
    admin: new AdminService({ service: node.service, clock: node.clock, tokenTtlMs: 60_000 }),
  };
}

describe('AdminService', () => {
  test('no superusers until one is upserted', async () => {
    const { admin } = await setup();
    expect(await admin.hasSuperusers()).toEqual({ ok: true, value: false });
    const created = await admin.upsertSuperuser(creds);
    expect(created).toMatchObject({ ok: true, value: { email: 'admin@example.com' } });
    expect(await admin.hasSuperusers()).toEqual({ ok: true, value: true });
  });

  test('superusers live in the system tenant, invisible to RESP sessions', async () => {
    const { node, admin } = await setup();
    await admin.upsertSuperuser(creds);
    expect(await node.run(node.open(), 'KEYS', '*')).toEqual([]);
  });

  test('login returns a token that verifies to the superuser', async () => {
    const { admin } = await setup();
    await admin.upsertSuperuser(creds);
    const auth = await admin.authWithPassword('admin@example.com', creds.password);
    if (!auth.ok) throw new Error(auth.error.message);
    expect(auth.value.superuser.email).toBe('admin@example.com');
    expect(await admin.verifyToken(auth.value.token)).toMatchObject({
      ok: true,
      value: { email: 'admin@example.com' },
    });
  });

  test('wrong password and unknown email fail the same way', async () => {
    const { admin } = await setup();
    await admin.upsertSuperuser(creds);
    for (const [email, password] of [
      ['admin@example.com', 'wrong password!'],
      ['nobody@example.com', creds.password],
    ] as const) {
      expect(await admin.authWithPassword(email, password)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_CREDENTIALS' },
      });
    }
  });

  test('tokens expire', async () => {
    const { node, admin } = await setup();
    await admin.upsertSuperuser(creds);
    const auth = await admin.authWithPassword(creds.email, creds.password);
    if (!auth.ok) throw new Error(auth.error.message);
    node.clock.advance(60_001n);
    expect(await admin.verifyToken(auth.value.token)).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    });
  });

  test('a password reset revokes earlier tokens', async () => {
    const { admin } = await setup();
    await admin.upsertSuperuser(creds);
    const before = await admin.authWithPassword(creds.email, creds.password);
    if (!before.ok) throw new Error(before.error.message);
    await admin.upsertSuperuser({ ...creds, password: 'a brand new password' });
    expect((await admin.verifyToken(before.value.token)).ok).toBe(false);
    expect((await admin.authWithPassword(creds.email, creds.password)).ok).toBe(false);
    expect((await admin.authWithPassword(creds.email, 'a brand new password')).ok).toBe(true);
  });

  test('weak credentials are rejected with field errors', async () => {
    const { admin } = await setup();
    const weak = await admin.upsertSuperuser({ email: 'not-an-email', password: 'short' });
    expect(weak.ok || weak.error.code).toBe('INVALID_ARGUMENT');
    expect(weak.ok || Object.keys(weak.error.fields ?? {}).sort()).toEqual(['email', 'password']);
  });

  test('property: any change to a valid token is rejected', async () => {
    const { admin } = await setup();
    await admin.upsertSuperuser(creds);
    const auth = await admin.authWithPassword(creds.email, creds.password);
    if (!auth.ok) throw new Error(auth.error.message);
    const token = auth.value.token;
    await fc.assert(
      fc.asyncProperty(
        fc.nat(token.length - 1),
        fc.string({ minLength: 1, maxLength: 1 }),
        async (i, c) => {
          fc.pre(token[i] !== c);
          const tampered = token.slice(0, i) + c + token.slice(i + 1);
          expect((await admin.verifyToken(tampered)).ok).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
    expect((await admin.verifyToken('garbage')).ok).toBe(false);
    expect((await admin.verifyToken('')).ok).toBe(false);
  });
});
