import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

/**
 * Phase 9 gate (PLAN 24): the authorization matrix. Every rule slot × rule
 * mode × role × ownership case, over HTTP on a real node, against an oracle
 * of PocketBase's conventions (ADR-0018): a locked rule is 403, a failed list
 * rule filters, a failed view, update or delete rule is 404, a failed create
 * rule is 400; superusers bypass every rule.
 */

type Mode = 'locked' | 'public' | 'owner';
type Role = 'anonymous' | 'user' | 'superuser' | 'delegated' | 'apiKey' | 'otherTenant';
type Ownership = 'own' | 'other' | 'none';
type Slot = 'list' | 'view' | 'create' | 'update' | 'delete';

const MODES: Mode[] = ['locked', 'public', 'owner'];
const ROLES: Role[] = ['anonymous', 'user', 'superuser', 'delegated', 'apiKey', 'otherTenant'];
const OWNERSHIP: Ownership[] = ['own', 'other', 'none'];
const SLOTS: Slot[] = ['list', 'view', 'create', 'update', 'delete'];

const RULE: Record<Mode, (slot: Slot) => string | null> = {
  locked: () => null,
  public: () => '',
  // PocketBase's own advice: a guest's `@request.auth.id` is '', which equals an empty owner.
  owner: (slot) =>
    `@request.auth.id != '' && ${slot === 'create' ? '@request.body.owner' : 'owner'} = @request.auth.id`,
};

let node: Awaited<ReturnType<typeof startTestNode>>;
let base = '';
const tokens: Partial<Record<Role, string>> = {};
const ids = { ann: '', bob: '' };

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; tenant?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.tenant) headers['x-mindlog-tenant'] = opts.tenant;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
  };
}

const asSuper = { token: '' };
const must = async (
  p: Promise<{ status: number; json: Record<string, unknown> | undefined }>,
  what: string,
) => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${String(r.status)} ${JSON.stringify(r.json)}`);
  return r.json ?? {};
};

async function signup(collection: string, email: string, tenant?: string) {
  const made = await must(
    call('POST', `/api/collections/${collection}/records`, {
      body: { email, password: 'password123', passwordConfirm: 'password123' },
      ...(tenant ? { tenant } : {}),
    }),
    `signup ${email}`,
  );
  const signed = await must(
    call('POST', `/api/collections/${collection}/auth-with-password`, {
      body: { identity: email, password: 'password123' },
      ...(tenant ? { tenant } : {}),
    }),
    `login ${email}`,
  );
  return { id: String(made['id']), token: String(signed['token']) };
}

const userCollection = (name: string, manageRule: string | null) => ({
  name,
  type: 'auth',
  fields: [{ name: 'role', type: 'select', values: ['admin', 'member'] }],
  listRule: '',
  viewRule: '',
  createRule: '',
  updateRule: 'id = @request.auth.id',
  deleteRule: null,
  manageRule,
});

beforeAll(async () => {
  node = await startTestNode({ limits: { authBurst: 10_000 } });
  base = `http://127.0.0.1:${String(node.node.http.port)}`;
  await node.node.admin.upsertSuperuser({ email: 'admin@x.io', password: 'correct horse battery' });
  const login = await must(
    call('POST', '/api/superusers/auth-with-password', {
      body: { email: 'admin@x.io', password: 'correct horse battery' },
    }),
    'superuser login',
  );
  asSuper.token = String(login['token']);
  tokens.superuser = asSuper.token;
  await must(
    call('POST', '/api/collections', { token: asSuper.token, body: userCollection('users', null) }),
    'users',
  );
  for (const mode of MODES) {
    await must(
      call('POST', '/api/collections', {
        token: asSuper.token,
        body: {
          name: `items_${mode}`,
          fields: [
            { name: 'title', type: 'text' },
            { name: 'owner', type: 'relation', collection: 'users' },
          ],
          listRule: RULE[mode]('list'),
          viewRule: RULE[mode]('view'),
          createRule: RULE[mode]('create'),
          updateRule: RULE[mode]('update'),
          deleteRule: RULE[mode]('delete'),
        },
      }),
      `items_${mode}`,
    );
  }
  const ann = await signup('users', 'ann@x.io');
  const bob = await signup('users', 'bob@x.io');
  ids.ann = ann.id;
  ids.bob = bob.id;
  tokens.user = ann.token;
  const key = await node.node.apiKeys.create({ tenant: 'default', name: 'assistant' });
  if (!key.ok) throw new Error(key.error.message);
  tokens.apiKey = key.value.key;
  const delegated = await must(
    call('POST', '/api/auth/delegate', { token: key.value.key, body: { userToken: ann.token } }),
    'delegate',
  );
  tokens.delegated = String(delegated['token']);
  // A user of another tenant, whose token names that tenant.
  await must(
    call('POST', '/api/collections', {
      token: asSuper.token,
      tenant: 'other',
      body: userCollection('users', null),
    }),
    'other users',
  );
  tokens.otherTenant = (await signup('users', 'eve@x.io', 'other')).token;
}, 60_000);

afterAll(async () => {
  await node.stop();
});

const ownerOf = (o: Ownership) => (o === 'own' ? ids.ann : o === 'other' ? ids.bob : '');

/** Whether the role acts as Ann (whose record "own" is). */
const asAnn = (role: Role) => role === 'user' || role === 'delegated';

function expected(
  slot: Slot,
  mode: Mode,
  role: Role,
  own: Ownership,
): { status: number; visible?: boolean } {
  const ok = { list: 200, view: 200, create: 200, update: 200, delete: 204 }[slot];
  if (role === 'otherTenant') return { status: 404 };
  if (role === 'superuser')
    return slot === 'list' ? { status: 200, visible: true } : { status: ok };
  if (mode === 'locked') return { status: 403 };
  const passes = mode === 'public' || (asAnn(role) && own === 'own');
  if (slot === 'list') return { status: 200, visible: passes };
  if (passes) return { status: ok };
  return { status: slot === 'create' ? 400 : 404 };
}

async function seed(mode: Mode, own: Ownership): Promise<string> {
  const made = await must(
    call('POST', `/api/collections/items_${mode}/records`, {
      token: asSuper.token,
      body: { title: 'seed', owner: ownerOf(own) },
    }),
    'seed',
  );
  return String(made['id']);
}

async function attempt(slot: Slot, mode: Mode, role: Role, own: Ownership) {
  const token = tokens[role];
  const opts = token ? { token } : {};
  const path = `/api/collections/items_${mode}/records`;
  switch (slot) {
    case 'list': {
      const id = await seed(mode, own);
      const r = await call('GET', `${path}?perPage=500`, opts);
      const items = (r.json?.['items'] as { id: string }[] | undefined) ?? [];
      return { status: r.status, visible: items.some((i) => i.id === id) };
    }
    case 'view':
      return call('GET', `${path}/${await seed(mode, own)}`, opts);
    case 'create':
      return call('POST', path, { ...opts, body: { title: 'new', owner: ownerOf(own) } });
    case 'update':
      return call('PATCH', `${path}/${await seed(mode, own)}`, {
        ...opts,
        body: { title: 'changed' },
      });
    case 'delete':
      return call('DELETE', `${path}/${await seed(mode, own)}`, opts);
  }
}

const cases = SLOTS.flatMap((slot) =>
  MODES.flatMap((mode) =>
    ROLES.flatMap((role) => OWNERSHIP.map((own) => ({ slot, mode, role, own }))),
  ),
);

describe('authorization matrix: rule slot × mode × role × ownership', () => {
  test(`${String(cases.length)} cases match the oracle`, async () => {
    const failures: string[] = [];
    for (const c of cases) {
      const want = expected(c.slot, c.mode, c.role, c.own);
      const got = await attempt(c.slot, c.mode, c.role, c.own);
      const visible = 'visible' in got ? got.visible : undefined;
      if (got.status !== want.status || (want.visible !== undefined && visible !== want.visible)) {
        failures.push(
          `${c.slot}/${c.mode}/${c.role}/${c.own}: want ${JSON.stringify(want)} got ${String(got.status)} visible=${String(visible)}`,
        );
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  test('manageRule: who may change auth fields (verified) of a user', async () => {
    const MANAGE: Record<Mode, string | null> = {
      locked: null,
      public: '',
      owner: "@request.auth.role = 'admin'",
    };
    const failures: string[] = [];
    for (const mode of MODES) {
      const name = `staff_${mode}`;
      await must(
        call('POST', '/api/collections', {
          token: asSuper.token,
          body: userCollection(name, MANAGE[mode]),
        }),
        name,
      );
      const ann = await signup(name, `ann@${mode}.io`);
      const bob = await signup(name, `bob@${mode}.io`);
      const boss = await signup(name, `boss@${mode}.io`);
      await must(
        call('PATCH', `/api/collections/${name}/records/${boss.id}`, {
          token: asSuper.token,
          body: { role: 'admin' },
        }),
        'promote',
      );
      // The updateRule lets users update themselves only, so changing another user is a 404 before manageRule matters.
      const roles: [string, string | undefined, string, number][] = [
        ['superuser on other', asSuper.token, bob.id, 200],
        ['anonymous on other', undefined, bob.id, 404],
        ['user on self', ann.token, ann.id, mode === 'public' ? 200 : 400],
        ['user on other', ann.token, bob.id, 404],
        ['admin on self', boss.token, boss.id, mode === 'locked' ? 400 : 200],
      ];
      for (const [label, token, target, want] of roles) {
        const r = await call('PATCH', `/api/collections/${name}/records/${target}`, {
          ...(token ? { token } : {}),
          body: { verified: true },
        });
        if (r.status !== want)
          failures.push(
            `${mode}/${label}: want ${String(want)} got ${String(r.status)} ${JSON.stringify(r.json)}`,
          );
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  test('tenants are isolated: a token works only in its own tenant', async () => {
    const r = await call('GET', '/api/collections/items_public/records', {
      token: tokens.otherTenant ?? '',
      tenant: 'default',
    });
    expect(r.status).toBe(404);
    const listed = await call('GET', '/api/collections', { token: tokens.user ?? '' });
    expect(listed.status).toBe(403);
  });

  test('hidden fields never leave the server, even for the owner', async () => {
    const me = await call('GET', `/api/collections/users/records/${ids.ann}`, {
      token: tokens.user ?? '',
    });
    expect(me.status).toBe(200);
    expect(Object.keys(me.json ?? {})).not.toContain('password');
    expect(Object.keys(me.json ?? {})).not.toContain('tokenKey');
    const others = await call('GET', `/api/collections/users/records/${ids.bob}`, {
      token: tokens.user ?? '',
    });
    expect(others.json?.['email']).toBeUndefined();
  });
});
