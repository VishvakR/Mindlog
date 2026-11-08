import { afterAll, beforeAll, expect, test } from 'vitest';
import { ClientError, MindlogClient } from '@mindlog/sdk';
import { startTestNode } from '../support/node.js';

let node: Awaited<ReturnType<typeof startTestNode>>;
let url = '';

beforeAll(async () => {
  node = await startTestNode({ limits: { authBurst: 1000 } });
  url = `http://127.0.0.1:${String(node.node.http.port)}`;
  await node.node.admin.upsertSuperuser({ email: 'admin@x.io', password: 'correct horse battery' });
  const admin = new MindlogClient(url);
  const { token } = await admin.send<{ token: string }>('/api/superusers/auth-with-password', {
    method: 'POST',
    body: { email: 'admin@x.io', password: 'correct horse battery' },
  });
  const owner = "@request.auth.id != '' && user = @request.auth.id";
  for (const body of [
    { name: 'users', type: 'auth', createRule: '', viewRule: 'id = @request.auth.id' },
    {
      name: 'todos',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'user', type: 'relation', collection: 'users' },
        { name: 'photo', type: 'file' },
      ],
      listRule: owner,
      viewRule: owner,
      createRule: "@request.auth.id != '' && @request.body.user = @request.auth.id",
      updateRule: owner,
      deleteRule: owner,
    },
  ]) {
    await admin.send('/api/collections', { method: 'POST', body, token });
  }
}, 60_000);

afterAll(async () => {
  await node.stop();
});

async function signedIn(email: string) {
  const m = new MindlogClient(url);
  await m
    .collection('users')
    .create({ email, password: 'password123', passwordConfirm: 'password123' });
  await m.collection('users').authWithPassword(email, 'password123');
  return { m, id: m.authStore.record?.id ?? '' };
}

test('sign in, CRUD, lists, errors, files and refresh', async () => {
  const { m, id } = await signedIn('ann@x.io');
  expect(m.authStore.isValid).toBe(true);
  const todos = m.collection('todos');
  const form = new FormData();
  form.append('title', 'milk');
  form.append('user', id);
  form.append('photo', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
  const made = await todos.create(form);
  expect((await todos.getOne(made.id))['title']).toBe('milk');
  const token = await m.getFileToken();
  const fileUrl = m.fileUrl({ id: made.id }, String(made['photo']), { collection: 'todos', token });
  expect(await (await fetch(fileUrl)).text()).toBe('hello');
  await todos.update(made.id, { title: 'oat milk' });
  expect((await todos.getList(1, 10, { filter: "title ~ 'oat'" })).totalItems).toBe(1);
  expect(await todos.getFullList()).toHaveLength(1);
  const failed = await todos.create({ title: '', user: id }).catch((e: unknown) => e);
  expect(failed).toBeInstanceOf(ClientError);
  expect((failed as ClientError).fields).toEqual({ title: 'cannot be blank' });
  const before = m.authStore.refreshToken;
  await m.collection('users').authRefresh();
  expect(m.authStore.refreshToken).not.toBe(before);
  await todos.delete(made.id);
  expect(await todos.getFullList()).toHaveLength(0);
});

test('subscribe delivers the owner’s changes and stops when told', async () => {
  const { m, id } = await signedIn('bob@x.io');
  const seen: string[] = [];
  const stop = await m
    .collection('todos')
    .subscribe('*', (e) => seen.push(`${e.action}:${String(e.record['title'])}`));
  const made = await m.collection('todos').create({ title: 'live', user: id });
  for (let i = 0; i < 300 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  expect(seen).toEqual(['create:live']);
  await stop();
  await m.collection('todos').delete(made.id);
  await new Promise((r) => setTimeout(r, 100));
  expect(seen).toEqual(['create:live']);
});

test('the auth store persists through its storage and an agent can act for a user', async () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  const first = new MindlogClient(url, { storage });
  await first
    .collection('users')
    .create({ email: 'cat@x.io', password: 'password123', passwordConfirm: 'password123' });
  await first.collection('users').authWithPassword('cat@x.io', 'password123');
  const id = first.authStore.record?.id ?? '';
  await first.collection('todos').create({ title: 'cat food', user: id });
  const second = new MindlogClient(url, { storage });
  expect(second.authStore.record?.id).toBe(id);
  const key = await node.node.apiKeys.create({ tenant: 'default', name: 'assistant' });
  if (!key.ok) throw new Error(key.error.message);
  const agent = new MindlogClient(url);
  agent.authStore.save(await agent.delegate(key.value.key, first.authStore.token), null);
  expect((await agent.collection('todos').getFullList()).map((t) => t['title'])).toEqual([
    'cat food',
  ]);
  second.authStore.clear();
  expect(data.size).toBe(0);
});
