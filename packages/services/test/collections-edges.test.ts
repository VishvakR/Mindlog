import { describe, expect, test } from 'vitest';
import { err, mindlogError, ok as okResult } from '@mindlog/core';
import type { CollectionInput } from '@mindlog/collections';
import { sha256 } from '@mindlog/auth';
import { collectionsNode } from './support/collections-node.js';

const must = <T>(
  r: { ok: true; value: T } | { ok: false; error: { message: string; fields?: unknown } },
): T => {
  if (!r.ok) throw new Error(`${r.error.message} ${JSON.stringify(r.error.fields)}`);
  return r.value;
};
type Failed = {
  ok: false;
  error: { code: string; message: string; fields?: Record<string, string> };
};
const failure = (r: unknown) => (r as Failed).error;

const users: CollectionInput = {
  name: 'users',
  type: 'auth',
  fields: [
    { name: 'name', type: 'text' },
    { name: 'role', type: 'text' },
  ],
  createRule: '',
  listRule: '',
  viewRule: '',
  updateRule: 'id = @request.auth.id',
};
const creds = { password: 'password123', passwordConfirm: 'password123' };

async function setup(options: Parameters<typeof collectionsNode>[0] = {}) {
  const n = await collectionsNode(options);
  must(await n.collections.saveCollection(n.superuser, users));
  const su = n.superuser;
  const ann = must(
    await n.collections.create(n.anonymous, 'users', { email: 'ann@x.io', name: 'Ann', ...creds }),
  ).raw.id;
  const bob = must(
    await n.collections.create(n.anonymous, 'users', { email: 'bob@x.io', name: 'Bob', ...creds }),
  ).raw.id;
  return { ...n, su, ann, bob };
}

const things: CollectionInput = {
  name: 'things',
  fields: [
    { name: 'title', type: 'text' },
    { name: 'n', type: 'number' },
    { name: 'tags', type: 'select', values: ['a', 'b', 'c'], maxSelect: 3 },
    { name: 'one', type: 'select', values: ['a', 'b'] },
    { name: 'owners', type: 'relation', collection: 'users', maxSelect: 3 },
    { name: 'owner', type: 'relation', collection: 'users' },
    { name: 'stamp', type: 'autodate', onCreate: true, onUpdate: true },
    { name: 'made', type: 'autodate', onCreate: true },
    { name: 'text', type: 'text' },
    { name: 'vec', type: 'vector', source: 'text' },
    { name: 'attachment', type: 'file' },
  ],
  indexes: [
    { name: 'by_n', fields: ['n'] },
    { name: 'by_owner', fields: ['owner'] },
  ],
  listRule: '',
  viewRule: '',
  createRule: '',
  updateRule: '',
  deleteRule: '',
};

describe('record writes', () => {
  test('refused bodies carry per-field messages', async () => {
    const n = await setup();
    must(await n.collections.saveCollection(n.su, things));
    const c = n.collections;
    expect(failure(await c.create(n.su, 'things', { id: 'BAD!' })).fields).toEqual({
      id: 'must be 15 characters of a-z and 0-9',
    });
    expect(failure(await c.create(n.su, 'things', { ghost: 1, 'ghost+': 1 })).fields).toEqual({
      ghost: 'unknown field',
      'ghost+': 'unknown field',
    });
    expect(failure(await c.create(n.su, 'things', { stamp: 'x', vec: [1] })).fields).toEqual({
      stamp: 'is set by Mindlog',
      vec: 'is set by Mindlog',
    });
    expect(failure(await c.create(n.su, 'things', { n: {} })).fields).toEqual({
      n: 'invalid value',
    });
    expect(failure(await c.create(n.su, 'things', { 'title+': 'x' })).fields).toEqual({
      'title+': 'modifiers work on number, select, relation and file fields',
    });
    expect(failure(await c.create(n.su, 'things', { '+n': 1 })).fields).toEqual({
      '+n': 'invalid modifier',
    });
    expect(failure(await c.create(n.su, 'things', { 'attachment+': ['x.png'] })).fields).toEqual({
      attachment: 'files must be uploaded',
    });
    expect(
      failure(await c.create(n.su, 'things', {}, { files: { title: ['a.txt'] } })).fields,
    ).toEqual({ title: 'not a file field' });
    expect(failure(await c.create(n.su, 'ghosts', {})).code).toBe('NOT_FOUND');
    expect(failure(await c.update(n.su, 'ghosts', 'x', {})).code).toBe('NOT_FOUND');
    expect(failure(await c.delete(n.su, 'ghosts', 'x')).code).toBe('NOT_FOUND');
    expect(failure(await c.update(n.su, 'things', 'aaaaaaaaaaaaaaa', {})).code).toBe('NOT_FOUND');
  });

  test('modifiers, autodates and single-value selects', async () => {
    const n = await setup();
    must(await n.collections.saveCollection(n.su, things));
    const c = n.collections;
    const made = must(
      await c.create(n.su, 'things', {
        n: 5,
        'n-': 2,
        tags: ['a'],
        'tags+': ['b'],
        one: 'a',
        owners: [n.ann],
      }),
    );
    expect(made.record).toMatchObject({ n: 3, tags: ['a', 'b'], one: 'a' });
    expect(made.record['stamp']).toBe(made.record['made']);
    n.clock.advance(5000n);
    const id = made.raw.id;
    const next = must(
      await c.update(n.su, 'things', id, {
        'tags-': ['a'],
        '+tags': ['c'],
        'one+': 'b',
        'owners-': [n.ann],
        'owners+': [n.bob],
      }),
    );
    expect(next.record).toMatchObject({ tags: ['c', 'b'], one: 'b', owners: [n.bob] });
    expect(next.record['stamp']).not.toBe(next.record['made']);
    expect(must(await c.update(n.su, 'things', id, { 'one-': 'b' })).record['one']).toBe('');
  });

  test('vector fields embed their source, once, and degrade without models', async () => {
    const calls: string[] = [];
    let up = true;
    const embedder = {
      embed: (texts: readonly string[]) => {
        calls.push(...texts);
        return Promise.resolve(
          up
            ? okResult({ vectors: [new Float32Array([0.5, 0.25])] })
            : err(mindlogError('UNAVAILABLE', 'down')),
        );
      },
    };
    const n = await setup({ deps: { embedder } });
    must(await n.collections.saveCollection(n.su, things));
    const c = n.collections;
    const made = must(await c.create(n.su, 'things', { text: 'hello' }));
    expect([made.record['vec'], made.degraded]).toEqual([[0.5, 0.25], false]);
    must(await c.update(n.su, 'things', made.raw.id, { n: 1 }));
    expect(calls).toEqual(['hello']);
    up = false;
    const down = must(await c.update(n.su, 'things', made.raw.id, { text: 'bye' }));
    expect([down.record['vec'], down.degraded]).toEqual([null, true]);
    const empty = must(await c.create(n.su, 'things', {}));
    expect([empty.record['vec'], empty.degraded]).toEqual([null, false]);
    const none = await setup();
    must(await none.collections.saveCollection(none.su, things));
    expect(must(await none.collections.create(none.su, 'things', { text: 'x' })).degraded).toBe(
      true,
    );
  });

  test('passwords and auth fields', async () => {
    const n = await setup();
    const c = n.collections;
    const asAnn = n.as(n.ann);
    const email = 'c@x.io';
    expect(failure(await c.create(n.anonymous, 'users', { email })).fields).toEqual({
      password: 'cannot be blank',
    });
    expect(
      failure(
        await c.create(n.anonymous, 'users', {
          email,
          password: 'short',
          passwordConfirm: 'short',
        }),
      ).fields,
    ).toEqual({ password: 'at least 8 characters' });
    expect(
      failure(
        await c.create(n.anonymous, 'users', {
          email,
          password: 'password123',
          passwordConfirm: 'other',
        }),
      ).fields,
    ).toEqual({ passwordConfirm: 'does not match the password' });
    expect(failure(await c.create(n.anonymous, 'users', { ...creds })).fields).toEqual({
      email: 'cannot be blank',
    });
    expect(
      failure(await c.create(n.anonymous, 'users', { email, ...creds, tokenKey: 'x' })).fields,
    ).toEqual({ tokenKey: 'is set by Mindlog' });
    expect(
      failure(
        await c.update(asAnn, 'users', n.ann, {
          password: 'newpassword1',
          passwordConfirm: 'newpassword1',
          oldPassword: 'wrong',
        }),
      ).fields,
    ).toEqual({ oldPassword: 'is not the current password' });
    expect(
      failure(
        await c.update(asAnn, 'users', n.ann, {
          password: 'newpassword1',
          passwordConfirm: 'newpassword1',
        }),
      ).fields,
    ).toEqual({ oldPassword: 'is not the current password' });
    const sameEmail = must(
      await c.update(asAnn, 'users', n.ann, { email: 'ann@x.io', name: 'Annie' }),
    );
    expect(sameEmail.record['name']).toBe('Annie');
    const verified = must(await c.create(n.su, 'users', { email, verified: true, ...creds }));
    expect(verified.record['verified']).toBe(true);
  });

  test('views are read-only and locked rules answer 403 on every write', async () => {
    const n = await setup();
    const c = n.collections;
    must(await c.saveCollection(n.su, { name: 'locked', fields: [{ name: 't', type: 'text' }] }));
    must(
      await c.saveCollection(n.su, {
        name: 'v',
        type: 'view',
        fields: [{ name: 'n', type: 'number' }],
        view: { from: 'users', group: [], select: { n: 'count(users.id)' } },
      }),
    );
    const id = must(await c.create(n.su, 'locked', { t: 'x' })).raw.id;
    const asAnn = n.as(n.ann);
    for (const r of [
      await c.create(asAnn, 'locked', {}),
      await c.update(asAnn, 'locked', id, {}),
      await c.delete(asAnn, 'locked', id),
      await c.view(asAnn, 'locked', id),
      await c.list(asAnn, 'locked'),
    ]) {
      expect(failure(r).code).toBe('PERMISSION_DENIED');
    }
    for (const r of [
      await c.update(n.su, 'v', 'aaaaaaaaaaaaaaa', {}),
      await c.delete(n.su, 'v', 'aaaaaaaaaaaaaaa'),
    ]) {
      expect(failure(r).message).toBe('View collections are read-only.');
    }
  });
});

describe('reads', () => {
  test('filters, sorts, field picks, expands and @collection through an index', async () => {
    const n = await setup();
    const c = n.collections;
    must(
      await c.saveCollection(n.su, {
        ...things,
        listRule: '@collection.things.owner ?= @request.auth.id',
        viewRule: 'owner = @request.auth.id',
      }),
    );
    const a = must(
      await c.create(n.su, 'things', { title: 'a', n: 2, owner: n.ann, owners: [n.ann, n.bob] }),
    ).raw.id;
    must(await c.create(n.su, 'things', { title: 'b', n: 1, owner: n.bob }));
    const asAnn = n.as(n.ann);
    expect(
      must(await c.list(n.su, 'things', { sort: 'n,-title' })).items.map((i) => i['title']),
    ).toEqual(['b', 'a']);
    expect(must(await c.list(n.su, 'things', { sort: '+id' })).totalItems).toBe(2);
    expect(failure(await c.list(n.su, 'things', { sort: 'ghost' })).message).toBe(
      'cannot sort by ghost',
    );
    expect(must(await c.list(asAnn, 'things', {})).totalItems).toBe(2);
    expect(must(await c.list(n.anonymous, 'things', {})).totalItems).toBe(0);
    expect(
      must(await c.list(asAnn, 'things', { filter: 'n > 1' })).items.map((i) => i['id']),
    ).toEqual([a]);
    expect(must(await c.view(asAnn, 'things', a))['title']).toBe('a');
    expect(failure(await c.view(n.as(n.bob), 'things', a)).code).toBe('NOT_FOUND');
    expect(failure(await c.list(asAnn, 'things', { sort: 'attachment,ghost' })).message).toBe(
      'cannot sort by ghost',
    );
  }, 20_000);

  test('expansion honours the target view rule, and paging clamps', async () => {
    const n = await setup();
    const c = n.collections;
    must(
      await c.saveCollection(n.su, {
        name: 'teams',
        fields: [{ name: 'name', type: 'text' }],
        viewRule: "name != 'secret'",
        listRule: '',
      }),
    );
    must(
      await c.saveCollection(n.su, {
        name: 'orgs',
        fields: [
          { name: 'teams', type: 'relation', collection: 'teams', maxSelect: 2 },
          { name: 'lead', type: 'relation', collection: 'teams' },
        ],
        listRule: '',
        viewRule: '',
      }),
    );
    const open = must(await c.create(n.su, 'teams', { name: 'open' })).raw.id;
    const secret = must(await c.create(n.su, 'teams', { name: 'secret' })).raw.id;
    const org = must(await c.create(n.su, 'orgs', { teams: [open, secret], lead: secret })).raw.id;
    const view = must(await c.view(n.anonymous, 'orgs', org, { expand: 'teams,lead,ghost' }));
    expect((view['expand'] as { teams: { name: string }[] }).teams.map((t) => t.name)).toEqual([
      'open',
    ]);
    expect((view['expand'] as Record<string, unknown>)['lead']).toBeUndefined();
    const star = must(await c.view(n.su, 'orgs', org, { fields: '*' }));
    expect(star['teams']).toEqual([open, secret]);
    const page = must(await c.list(n.anonymous, 'orgs', { page: 0, perPage: 99999 }));
    expect([page.page, page.perPage]).toEqual([1, 500]);
    expect(failure(await c.view(n.anonymous, 'orgs', 'aaaaaaaaaaaaaaa')).code).toBe('NOT_FOUND');
    expect(failure(await c.view(n.anonymous, 'ghosts', 'x')).code).toBe('NOT_FOUND');
    expect(failure(await c.list(n.anonymous, 'ghosts')).code).toBe('NOT_FOUND');
    expect(failure(await c.list(n.anonymous, 'orgs', { filter: '(' })).message).toContain(
      'invalid filter',
    );
    const noRule = must(await c.list(n.anonymous, 'orgs', { filter: '  ' }));
    expect(noRule.totalItems).toBe(1);
  });

  test('tenant and version gates, and missing schemas', async () => {
    const off = await collectionsNode({ deps: { enabled: () => false } });
    expect(failure(await off.collections.list(off.superuser, 'x')).message).toContain(
      'not enabled',
    );
    expect(failure(await off.collections.listCollections(off.superuser)).message).toContain(
      'not enabled',
    );
    expect(failure(await off.collections.view(off.superuser, 'x', 'y')).message).toContain(
      'not enabled',
    );
    const old = await collectionsNode({ deps: { clusterVersion: () => 8 } });
    expect(failure(await old.collections.saveCollection(old.superuser, { name: 'x' })).code).toBe(
      'UNAVAILABLE',
    );
    expect(failure(await old.collections.deleteCollection(old.superuser, 'x')).code).toBe(
      'UNAVAILABLE',
    );
    expect(failure(await old.collections.create(old.superuser, 'x', {})).code).toBe('UNAVAILABLE');
    const sys = { ...old.superuser, tenant: '$system' };
    expect(failure(await old.collections.list(sys, 'x')).message).toContain('not enabled');
    const n = await setup();
    const c = n.collections;
    const asAnn = n.as(n.ann);
    for (const r of [
      await c.listCollections(asAnn),
      await c.getCollection(asAnn, 'users'),
      await c.saveCollection(asAnn, { name: 'x' }),
      await c.deleteCollection(asAnn, 'users'),
      await c.checkRuleText(asAnn, { collection: 'users', rule: '' }),
    ]) {
      expect(failure(r).code).toBe('PERMISSION_DENIED');
    }
    expect(failure(await c.getCollection(n.su, 'ghosts')).code).toBe('NOT_FOUND');
    expect(failure(await c.getCollection(n.su, 'bad name')).code).toBe('NOT_FOUND');
    expect(failure(await c.deleteCollection(n.su, 'ghosts')).code).toBe('NOT_FOUND');
    expect(must(await c.listCollections(n.su)).map((i) => i.schema.name)).toEqual(['users']);
    expect(must(await c.checkRuleText(n.su, { collection: 'users', rule: '' })).issues).toEqual([]);
    const draft = must(
      await c.checkRuleText(n.su, {
        collection: 'd',
        rule: 'x = 1',
        draft: { name: 'd', fields: [{ name: 'x', type: 'number' }] },
      }),
    );
    expect(draft.issues).toEqual([]);
    const invalid = must(await c.checkRuleText(n.su, { collection: 'users', rule: "a = 'x" }));
    expect(invalid.issues[0]?.message).toBe('unterminated string');
  });
});

describe('app auth edges', () => {
  const email = 'ann@x.io';

  test('wrong collections, bad tokens and disabled methods', async () => {
    const n = await setup();
    const a = n.auth;
    must(await n.collections.saveCollection(n.su, { name: 'plain' }));
    expect(failure(await a.authWithPassword('acme', 'plain', email, 'x')).code).toBe('NOT_FOUND');
    expect(failure(await a.authWithPassword('acme', 'users', 'nobody@x.io', 'x')).message).toBe(
      'Failed to authenticate.',
    );
    for (const t of ['', 'a.b', 'a.b.c']) expect((await a.authenticate(t)).ok).toBe(false);
    expect((await a.refresh('acme', 'users', {})).ok).toBe(false);
    expect((await a.refresh('acme', 'users', { refreshToken: 'nope' })).ok).toBe(false);
    for (const r of [
      await a.requestOtp('acme', 'users', email),
      await a.authWithOtp('acme', 'users', 'x', 'y'),
      await a.requestVerification('acme', 'users', email),
      await a.requestPasswordReset('acme', 'users', email),
      await a.authWithOAuth2('acme', 'users', { provider: 'p', code: 'c', state: 's' }),
    ]) {
      expect(failure(r).message).toContain('not enabled');
    }
    expect((await a.authMethods('acme', 'plain')).ok).toBe(false);
    expect(must(await a.authMethods('acme', 'users'))).toEqual({
      password: { enabled: true },
      otp: { enabled: false },
      oauth2: { enabled: false, providers: [] },
    });
    expect(failure(await a.fileToken({ kind: 'anonymous' })).code).toBe('UNAUTHENTICATED');
    expect((await a.confirmVerification('acme', 'users', 'x')).ok).toBe(false);
    expect(
      (
        await a.confirmPasswordReset('acme', 'users', {
          token: 'x',
          password: 'p',
          passwordConfirm: 'p',
        })
      ).ok,
    ).toBe(false);
  });

  test('tokens: type, tenant, rotation and refresh by access token', async () => {
    const n = await setup();
    const a = n.auth;
    const signed = must(await a.authWithPassword('acme', 'users', email, 'password123'));
    expect((await a.delegate({ id: 'k', tenant: 'acme' }, signed.refreshToken)).ok).toBe(
      false,
    );
    const again = must(await a.refresh('acme', 'users', { token: signed.token }));
    expect(again.record['id']).toBe(n.ann);
    expect((await a.refresh('acme', 'plain', { token: signed.token })).ok).toBe(false);
    expect((await a.refresh('other', 'users', { token: signed.token })).ok).toBe(false);
    must(await a.keys.rotate());
    expect(must(await a.authenticate(signed.token))).toMatchObject({ id: n.ann });
    const fresh = must(await a.authWithPassword('acme', 'users', email, 'password123'));
    expect(fresh.token).not.toBe(signed.token);
    const file = must(
      await a.fileToken({ kind: 'record', tenant: 'acme', collection: 'users', id: n.ann }),
    );
    expect((await a.authenticate(file)).ok).toBe(false);
    const gone = must(await a.authWithPassword('acme', 'users', 'bob@x.io', 'password123'));
    must(await n.collections.update(n.su, 'users', n.bob, { name: 'x' }));
    must(await n.auth.authenticate(gone.token));
  });

  test('required verification, expired refresh sessions and session collection reuse', async () => {
    const n = await setup();
    const current = must(await n.collections.getCollection(n.su, 'users'));
    must(
      await n.collections.saveCollection(
        n.su,
        { ...users, auth: { requireVerified: true } },
        current.version,
      ),
    );
    expect(failure(await n.auth.authWithPassword('acme', 'users', email, 'password123')).code).toBe(
      'PERMISSION_DENIED',
    );
    must(await n.collections.update(n.su, 'users', n.ann, { verified: true }));
    const signed = must(await n.auth.authWithPassword('acme', 'users', email, 'password123'));
    n.clock.advance(31n * 86_400_000n);
    expect((await n.auth.refresh('acme', 'users', { refreshToken: signed.refreshToken })).ok).toBe(
      false,
    );
  });

  test('password sign-in can be turned off; OTP codes expire and run out of attempts', async () => {
    const n = await setup({ mailer: true });
    const current = must(await n.collections.getCollection(n.su, 'users'));
    must(
      await n.collections.saveCollection(
        n.su,
        { ...users, auth: { password: { enabled: false }, otp: { enabled: true, durationS: 60 } } },
        current.version,
      ),
    );
    expect(
      failure(await n.auth.authWithPassword('acme', 'users', email, 'password123')).message,
    ).toContain('not enabled');
    const a = must(await n.auth.requestOtp('acme', 'users', email)).otpId;
    n.clock.advance(61_000n);
    expect((await n.auth.authWithOtp('acme', 'users', a, '000000')).ok).toBe(false);
    expect((await n.auth.authWithOtp('acme', 'users', a, '000000')).ok).toBe(false);
    const b = must(await n.auth.requestOtp('acme', 'users', email)).otpId;
    for (let i = 0; i < 5; i++)
      expect((await n.auth.authWithOtp('acme', 'users', b, 'zzzzzz')).ok).toBe(false);
    const code = /\d{6}/.exec(n.mailer?.sent[1]?.text ?? '')?.[0] ?? '';
    expect((await n.auth.authWithOtp('acme', 'users', b, code)).ok).toBe(false);
    const unknown = must(await n.auth.requestOtp('acme', 'users', 'nobody@x.io')).otpId;
    expect((await n.auth.authWithOtp('acme', 'users', unknown, sha256('x'))).ok).toBe(false);
    must(await n.collections.update(n.su, 'users', n.ann, { verified: true }));
    expect((await n.auth.requestVerification('acme', 'users', email)).ok).toBe(true);
    expect((await n.auth.requestOtp('acme', 'plain', email)).ok).toBe(false);
  });
});
