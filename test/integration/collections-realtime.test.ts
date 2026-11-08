import { afterAll, beforeAll, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

let node: Awaited<ReturnType<typeof startTestNode>>;
let base = '';

const api = async (method: string, path: string, opts: { token?: string; json?: unknown } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.json === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(opts.json === undefined ? {} : { body: JSON.stringify(opts.json) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

async function user(email: string) {
  const made = await api('POST', '/api/collections/users/records', {
    json: { email, password: 'password123', passwordConfirm: 'password123' },
  });
  const signed = await api('POST', '/api/collections/users/auth-with-password', {
    json: { identity: email, password: 'password123' },
  });
  return { id: String(made.json['id']), token: String(signed.json['token']) };
}

/** An SSE connection that collects its events. */
async function stream() {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/realtime`, { signal: abort.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let text = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += new TextDecoder().decode(value);
      }
    } catch {
      // aborted
    }
  })();
  const until = async (part: string) => {
    for (let i = 0; i < 400 && !text.includes(part); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(text).toContain(part);
  };
  await until('PB_CONNECT');
  const clientId = /"clientId":"([0-9a-f]+)"/.exec(text)?.[1] ?? '';
  return {
    clientId,
    until,
    text: () => text,
    close: () => {
      abort.abort();
    },
  };
}

beforeAll(async () => {
  node = await startTestNode({ limits: { authBurst: 1000 } });
  base = `http://127.0.0.1:${String(node.node.http.port)}`;
}, 60_000);

afterAll(async () => {
  await node.stop();
});

test('a change reaches only the subscribers its rules allow', async () => {
  await node.node.admin.upsertSuperuser({ email: 'admin@x.io', password: 'correct horse battery' });
  const admin = String(
    (
      await api('POST', '/api/superusers/auth-with-password', {
        json: { email: 'admin@x.io', password: 'correct horse battery' },
      })
    ).json['token'],
  );
  await api('POST', '/api/collections', {
    token: admin,
    json: { name: 'users', type: 'auth', createRule: '', viewRule: '' },
  });
  const owner = "@request.auth.id != '' && user = @request.auth.id";
  await api('POST', '/api/collections', {
    token: admin,
    json: {
      name: 'todos',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'user', type: 'relation', collection: 'users' },
      ],
      listRule: owner,
      viewRule: owner,
      createRule: owner.replace('user =', '@request.body.user ='),
      updateRule: owner,
      deleteRule: owner,
    },
  });
  const [ann, bob] = [await user('ann@x.io'), await user('bob@x.io')];
  const [annStream, bobStream, guest] = [await stream(), await stream(), await stream()];
  const sub = (clientId: string, token: string | undefined, subscriptions: string[]) =>
    api('POST', '/api/realtime', {
      ...(token ? { token } : {}),
      json: { clientId, subscriptions },
    });
  expect((await sub(annStream.clientId, ann.token, ['todos/*'])).status).toBe(204);
  expect((await sub(bobStream.clientId, bob.token, ['todos/*'])).status).toBe(204);
  expect((await sub(guest.clientId, undefined, ['todos/*'])).status).toBe(204);
  expect((await sub('nope', ann.token, ['todos/*'])).status).toBe(404);
  expect((await sub(annStream.clientId, bob.token, ['todos/*'])).status).toBe(403);
  expect((await sub(annStream.clientId, ann.token, ['bad topic'])).status).toBe(400);

  const made = await api('POST', '/api/collections/todos/records', {
    token: ann.token,
    json: { title: 'ann-secret', user: ann.id },
  });
  const id = String(made.json['id']);
  await annStream.until('ann-secret');
  await api('POST', '/api/collections/todos/records', {
    token: bob.token,
    json: { title: 'bob-secret', user: bob.id },
  });
  await bobStream.until('bob-secret');
  await api('PATCH', `/api/collections/todos/records/${id}`, {
    token: ann.token,
    json: { title: 'ann-renamed' },
  });
  await annStream.until('ann-renamed');
  await api('DELETE', `/api/collections/todos/records/${id}`, { token: ann.token });
  await annStream.until('"action":"delete"');
  expect(annStream.text()).toContain('event: todos/*');
  expect(annStream.text()).toMatch(/id: \d+:\d+\n/);
  expect(annStream.text()).not.toContain('bob-secret');
  expect(bobStream.text()).not.toContain('ann-');
  expect(guest.text()).not.toContain('secret');
  for (const s of [annStream, bobStream, guest]) s.close();
}, 30_000);
