import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, test } from 'vitest';
import type { CollectionInput } from '@mindlog/collections';
import type { RequestContext } from '@mindlog/services';
import { AppAuthService } from '@mindlog/services';
import { collectionsNode } from './support/collections-node.js';

const users: CollectionInput = {
  name: 'users',
  type: 'auth',
  fields: [{ name: 'name', type: 'text' }],
  listRule: 'id = @request.auth.id',
  viewRule: 'id = @request.auth.id',
  createRule: '',
  updateRule: 'id = @request.auth.id',
  deleteRule: null,
};

const owner = 'user = @request.auth.id';
const todos: CollectionInput = {
  name: 'todos',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'done', type: 'bool' },
    { name: 'points', type: 'number' },
    { name: 'tags', type: 'select', values: ['home', 'work', 'urgent'], maxSelect: 3 },
    { name: 'user', type: 'relation', collection: 'users', required: true },
  ],
  indexes: [{ name: 'by_user', fields: ['user'] }],
  listRule: owner,
  viewRule: owner,
  createRule: "@request.auth.id != '' && @request.body.user = @request.auth.id",
  updateRule: `${owner} && @request.body.user:changed = false`,
  deleteRule: owner,
};

async function setup(options: { remote?: boolean; mailer?: boolean } = {}) {
  const n = await collectionsNode(options);
  for (const c of [users, todos]) {
    const saved = await n.collections.saveCollection(n.superuser, c);
    if (!saved.ok) throw new Error(`${saved.error.message} ${JSON.stringify(saved.error.fields)}`);
  }
  const signup = async (email: string) => {
    const made = await n.collections.create(n.anonymous, 'users', {
      email,
      password: 'password123',
      passwordConfirm: 'password123',
      name: email,
    });
    if (!made.ok) throw new Error(made.error.message);
    return made.value.raw.id;
  };
  const ann = await signup('ann@x.io');
  const bob = await signup('bob@x.io');
  const todo = async (
    ctx: RequestContext,
    title: string,
    user: string,
    extra: Record<string, unknown> = {},
  ) => n.collections.create(ctx, 'todos', { title, user, ...extra });
  return { ...n, ann, bob, todo };
}

describe('collection schemas', () => {
  test('only superusers manage schemas; invalid rules and relations are refused', async () => {
    const n = await setup();
    const asAnn = n.as(n.ann);
    expect((await n.collections.saveCollection(asAnn, { name: 'x' })).ok).toBe(false);
    const badRule = await n.collections.saveCollection(n.superuser, {
      name: 'x',
      listRule: 'nope = 1',
    });
    expect(!badRule.ok && badRule.error.fields).toEqual({
      listRule: 'unknown field nope in x (at 0)',
    });
    const badRel = await n.collections.saveCollection(n.superuser, {
      name: 'y',
      fields: [{ name: 'r', type: 'relation', collection: 'ghosts' }],
    });
    expect(!badRel.ok && badRel.error.fields).toEqual({
      'fields.0.collection': 'no collection ghosts',
    });
    const again = await n.collections.saveCollection(n.superuser, todos);
    expect(!again.ok && again.error.code).toBe('ALREADY_EXISTS');
    const referenced = await n.collections.deleteCollection(n.superuser, 'users');
    expect(!referenced.ok && referenced.error.message).toContain('referenced by todos');
  });

  test('the rule editor gets issues and completions', async () => {
    const n = await setup();
    const checked = await n.collections.checkRuleText(n.superuser, {
      collection: 'todos',
      rule: 'user.na',
      cursor: 7,
    });
    expect(checked.ok && checked.value.issues.map((i) => i.message)).toEqual([
      'expected an operator such as = or ?=',
    ]);
    expect(checked.ok && checked.value.completions?.items.map((i) => i.label)).toEqual(['name']);
  });
});

describe('records under rules', () => {
  test('owners see and change their own records; others get 404 and filtered lists', async () => {
    const n = await setup();
    const asAnn = n.as(n.ann);
    const asBob = n.as(n.bob);
    const t1 = await n.todo(asAnn, 'milk', n.ann, { tags: ['home'] });
    if (!t1.ok) throw new Error(t1.error.message);
    await n.todo(asBob, 'deploy', n.bob);
    const id = t1.value.raw.id;
    expect((await n.collections.view(asBob, 'todos', id)).ok).toBe(false);
    const hidden = await n.collections.view(asBob, 'todos', id);
    expect(!hidden.ok && hidden.error.code).toBe('NOT_FOUND');
    const annList = await n.collections.list(asAnn, 'todos');
    expect(annList.ok && annList.value.items.map((i) => i['title'])).toEqual(['milk']);
    const anonList = await n.collections.list(n.anonymous, 'todos');
    expect(anonList.ok && anonList.value.totalItems).toBe(0);
    const bobUpdate = await n.collections.update(asBob, 'todos', id, { done: true });
    expect(!bobUpdate.ok && bobUpdate.error.code).toBe('NOT_FOUND');
    const annUpdate = await n.collections.update(asAnn, 'todos', id, {
      done: true,
      'points+': 3,
      '+tags': ['urgent'],
    });
    expect(annUpdate.ok && annUpdate.value.record).toMatchObject({
      done: true,
      points: 3,
      tags: ['urgent', 'home'],
    });
    const steal = await n.collections.update(asAnn, 'todos', id, { user: n.bob });
    expect(!steal.ok && steal.error.code).toBe('NOT_FOUND');
    expect((await n.collections.delete(asBob, 'todos', id)).ok).toBe(false);
    expect((await n.collections.delete(asAnn, 'todos', id)).ok).toBe(true);
  });

  test('create rules: guests and impostors get 400; locked rules 403; superusers bypass', async () => {
    const n = await setup();
    const guest = await n.todo(n.anonymous, 'x', n.ann);
    expect(!guest.ok && guest.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Failed to create record.',
    });
    const impostor = await n.todo(n.as(n.bob), 'x', n.ann);
    expect(!impostor.ok && impostor.error.code).toBe('INVALID_ARGUMENT');
    const locked = await n.collections.delete(n.as(n.ann), 'users', n.ann);
    expect(!locked.ok && locked.error.code).toBe('PERMISSION_DENIED');
    expect((await n.todo(n.superuser, 'admin made', n.ann)).ok).toBe(true);
    const all = await n.collections.list(n.superuser, 'todos');
    expect(all.ok && all.value.totalItems).toBe(1);
  });

  test('validation, relations, filters, sorting, paging, expand and hidden fields', async () => {
    const n = await setup();
    const asAnn = n.as(n.ann);
    const missing = await n.todo(asAnn, '', n.ann);
    expect(!missing.ok && missing.error.fields).toEqual({ title: 'cannot be blank' });
    const ghost = await n.collections.create(n.superuser, 'todos', {
      title: 'x',
      user: 'zzzzzzzzzzzzzzz',
    });
    expect(!ghost.ok && ghost.error.fields).toEqual({
      user: 'refers to a record that does not exist',
    });
    for (const [i, title] of ['c', 'a', 'b'].entries())
      await n.todo(asAnn, title, n.ann, { points: i });
    const sorted = await n.collections.list(asAnn, 'todos', {
      sort: '-title',
      filter: 'points >= 1',
      perPage: 1,
      page: 2,
      expand: 'user',
    });
    if (!sorted.ok) throw new Error(sorted.error.message);
    expect(sorted.value).toMatchObject({ page: 2, perPage: 1, totalItems: 2, totalPages: 2 });
    const item = sorted.value.items[0] ?? {};
    expect(item['title']).toBe('a');
    expect(item['expand']).toMatchObject({ user: { id: n.ann, email: 'ann@x.io' } });
    expect(
      Object.keys((item['expand'] as Record<string, Record<string, unknown>>)['user'] ?? {}),
    ).not.toContain('password');
    const badFilter = await n.collections.list(asAnn, 'todos', { filter: 'user.password != ""' });
    expect(!badFilter.ok && badFilter.error.message).toContain('password cannot be filtered on');
    const picked = await n.collections.list(asAnn, 'todos', {
      fields: 'id,title',
      skipTotal: true,
    });
    expect(picked.ok && picked.value.totalItems).toBe(-1);
    expect(picked.ok && Object.keys(picked.value.items[0] ?? {})).toEqual(['id', 'title']);
  });

  test('works through node-to-node forwarding', async () => {
    const n = await setup({ remote: true });
    const made = await n.todo(n.as(n.ann), 'remote', n.ann);
    expect(made.ok).toBe(true);
    const list = await n.collections.list(n.as(n.ann), 'todos');
    expect(list.ok && list.value.items.map((i) => i['title'])).toEqual(['remote']);
    expect(n.forwarded()).toBeGreaterThan(0);
  });
});

describe('app auth', () => {
  test('password sign-in, token authentication, refresh rotation and password change revocation', async () => {
    const n = await setup();
    const bad = await n.auth.authWithPassword('acme', 'users', 'ann@x.io', 'wrong');
    expect(!bad.ok && bad.error.message).toBe('Failed to authenticate.');
    const signed = await n.auth.authWithPassword('acme', 'users', 'ANN@x.io ', 'password123');
    if (!signed.ok) throw new Error(signed.error.message);
    expect(signed.value.record).toMatchObject({ id: n.ann, email: 'ann@x.io' });
    expect(signed.value.record['password']).toBeUndefined();
    expect(await n.auth.authenticate(signed.value.token)).toEqual({
      ok: true,
      value: { kind: 'record', tenant: 'acme', collection: 'users', id: n.ann },
    });
    const rotated = await n.auth.refresh('acme', 'users', {
      refreshToken: signed.value.refreshToken,
    });
    expect(rotated.ok).toBe(true);
    const reused = await n.auth.refresh('acme', 'users', {
      refreshToken: signed.value.refreshToken,
    });
    expect(reused.ok).toBe(false);
    const changed = await n.collections.update(n.as(n.ann), 'users', n.ann, {
      password: 'newpassword1',
      passwordConfirm: 'newpassword1',
      oldPassword: 'password123',
    });
    expect(changed.ok).toBe(true);
    expect((await n.auth.authenticate(signed.value.token)).ok).toBe(false);
    if (rotated.ok && 'refreshToken' in rotated.value) {
      expect(
        (await n.auth.refresh('acme', 'users', { refreshToken: rotated.value.refreshToken })).ok,
      ).toBe(false);
    }
  });

  test('users cannot verify themselves or change their email; emails stay unique', async () => {
    const n = await setup();
    const self = await n.collections.update(n.as(n.ann), 'users', n.ann, {
      verified: true,
      email: 'x@y.io',
    });
    expect(!self.ok && self.error.fields).toEqual({
      verified: 'only superusers can change it',
      email: 'only superusers can change it',
    });
    const dup = await n.collections.create(n.anonymous, 'users', {
      email: 'ann@x.io',
      password: 'password123',
      passwordConfirm: 'password123',
    });
    expect(!dup.ok && dup.error.fields).toEqual({ email: 'must be unique' });
  });

  test('delegated tokens act as the user; a key pinned to another user is refused', async () => {
    const n = await setup();
    await n.todo(n.as(n.ann), 'mine', n.ann);
    const signed = await n.auth.authWithPassword('acme', 'users', 'ann@x.io', 'password123');
    if (!signed.ok) throw new Error('login');
    const key = { id: 'k1', tenant: 'acme', name: 'assistant' };
    const delegated = await n.auth.delegate(key, signed.value.token);
    if (!delegated.ok) throw new Error(delegated.error.message);
    const identity = await n.auth.authenticate(delegated.value.token);
    expect(identity).toEqual({
      ok: true,
      value: { kind: 'delegated', tenant: 'acme', collection: 'users', id: n.ann, actor: 'k1' },
    });
    if (!identity.ok) return;
    const list = await n.collections.list({ identity: identity.value, tenant: 'acme' }, 'todos');
    expect(list.ok && list.value.items.map((i) => i['title'])).toEqual(['mine']);
    const pinned = await n.auth.delegate({ ...key, user: n.bob }, signed.value.token);
    expect(!pinned.ok && pinned.error.code).toBe('PERMISSION_DENIED');
    const otherTenant = await n.auth.delegate({ ...key, tenant: 'other' }, signed.value.token);
    expect(!otherTenant.ok && otherTenant.error.code).toBe('PERMISSION_DENIED');
  });

  test('opt-in OTP: off without a mailer and option; codes work once and expire', async () => {
    const off = await setup();
    expect((await off.auth.requestOtp('acme', 'users', 'ann@x.io')).ok).toBe(false);
    const n = await setup({ mailer: true });
    const current = await n.collections.getCollection(n.superuser, 'users');
    if (!current.ok) throw new Error('schema');
    await n.collections.saveCollection(
      n.superuser,
      { ...users, auth: { otp: { enabled: true } } },
      current.value.version,
    );
    const methods = await n.auth.authMethods('acme', 'users');
    expect(methods.ok && methods.value.otp.enabled).toBe(true);
    const unknown = await n.auth.requestOtp('acme', 'users', 'nobody@x.io');
    expect(unknown.ok).toBe(true);
    expect(n.mailer?.sent).toHaveLength(0);
    const requested = await n.auth.requestOtp('acme', 'users', 'ann@x.io');
    if (!requested.ok) throw new Error(requested.error.message);
    const code = /\d{6}/.exec(n.mailer?.sent[0]?.text ?? '')?.[0] ?? '';
    expect((await n.auth.authWithOtp('acme', 'users', requested.value.otpId, '000000')).ok).toBe(
      code === '000000',
    );
    const signed = await n.auth.authWithOtp('acme', 'users', requested.value.otpId, code);
    expect(signed.ok && signed.value.record['verified']).toBe(true);
    expect((await n.auth.authWithOtp('acme', 'users', requested.value.otpId, code)).ok).toBe(false);
  });

  test('opt-in password reset by email ends the old password', async () => {
    const n = await setup({ mailer: true });
    expect((await n.auth.requestPasswordReset('acme', 'users', 'ann@x.io')).ok).toBe(true);
    const token = /token: (\S+)/.exec(n.mailer?.sent[0]?.text ?? '')?.[1] ?? '';
    const reset = await n.auth.confirmPasswordReset('acme', 'users', {
      token,
      password: 'brandnew123',
      passwordConfirm: 'brandnew123',
    });
    expect(reset.ok).toBe(true);
    expect((await n.auth.authWithPassword('acme', 'users', 'ann@x.io', 'password123')).ok).toBe(
      false,
    );
    expect((await n.auth.authWithPassword('acme', 'users', 'ann@x.io', 'brandnew123')).ok).toBe(
      true,
    );
    expect(
      (
        await n.auth.confirmPasswordReset('acme', 'users', {
          token,
          password: 'again12345',
          passwordConfirm: 'again12345',
        })
      ).ok,
    ).toBe(false);
  });
});

describe('opt-in OAuth2 and email verification', () => {
  async function provider() {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') res.end(JSON.stringify({ access_token: 'at' }));
      else
        res.end(
          JSON.stringify({ sub: 'ext-9', email: 'New@X.io', email_verified: true, name: 'New' }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const fake = {
      name: 'fake',
      authUrl: `${base}/auth`,
      tokenUrl: `${base}/token`,
      userInfoUrl: `${base}/me`,
      clientId: 'c',
      clientSecret: 's',
      scopes: ['openid'],
    };
    return { fake, close: () => server.close() };
  }

  test('a provider signs in a new user once, and a forged state is refused', async () => {
    const n = await setup();
    const { fake, close } = await provider();
    const auth = new AppAuthService({
      collections: n.collections,
      kv: n.kv,
      clock: n.clock,
      providers: new Map([['fake', () => Promise.resolve({ ok: true as const, value: fake })]]),
    });
    expect(
      (await auth.authWithOAuth2('acme', 'users', { provider: 'fake', code: 'x', state: 'y' })).ok,
    ).toBe(false);
    const current = await n.collections.getCollection(n.superuser, 'users');
    if (!current.ok) throw new Error('schema');
    await n.collections.saveCollection(
      n.superuser,
      { ...users, auth: { oauth2: { enabled: true, providers: ['fake'] } } },
      current.value.version,
    );
    const methods = await auth.authMethods('acme', 'users', 'http://app/cb');
    if (!methods.ok) throw new Error(methods.error.message);
    const [entry] = methods.value.oauth2.providers;
    expect(entry?.authUrl).toContain('code_challenge_method=S256');
    const state = entry?.state ?? '';
    const forged = await auth.authWithOAuth2('acme', 'users', {
      provider: 'fake',
      code: 'c',
      state: `${state}x`,
    });
    expect(forged.ok).toBe(false);
    const first = await auth.authWithOAuth2('acme', 'users', {
      provider: 'fake',
      code: 'c',
      state,
    });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.record).toMatchObject({ email: 'new@x.io', verified: true });
    const again = await auth.authWithOAuth2('acme', 'users', {
      provider: 'fake',
      code: 'c',
      state,
    });
    expect(again.ok && again.value.record['id']).toBe(first.value.record['id']);
    close();
  });

  test('verification mail confirms an email; other collections refuse the token', async () => {
    const n = await setup({ mailer: true });
    expect((await n.auth.requestVerification('acme', 'users', 'ann@x.io')).ok).toBe(true);
    expect((await n.auth.requestVerification('acme', 'users', 'nobody@x.io')).ok).toBe(true);
    expect(n.mailer?.sent).toHaveLength(1);
    const token = /token: (\S+)/.exec(n.mailer?.sent[0]?.text ?? '')?.[1] ?? '';
    expect((await n.auth.confirmVerification('acme', 'todos', token)).ok).toBe(false);
    expect((await n.auth.confirmVerification('acme', 'users', token)).ok).toBe(true);
    const me = await n.collections.view(n.as(n.ann), 'users', n.ann);
    expect(me.ok && me.value['verified']).toBe(true);
  });
});
