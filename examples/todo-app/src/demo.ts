import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { RealtimeEvent } from '@mindlog/sdk';
import { ClientError, MindlogClient } from '@mindlog/sdk';
import { summarize } from './agent.ts';

// Phase 9 gate (PLAN 24): the whole app, headless, through the SDK. scripts/phase9-demo.sh runs it.

const url = process.env['MINDLOG_URL'] ?? 'http://127.0.0.1:8090';
const apiKey = process.env['MINDLOG_API_KEY'] ?? '';
const step = (what: string) => {
  console.log(`ok - ${what}`);
};

async function signUp(email: string) {
  const c = new MindlogClient(url);
  await c
    .collection('users')
    .create({ email, password: 'password123', passwordConfirm: 'password123' });
  await c.collection('users').authWithPassword(email, 'password123');
  return { c, id: c.authStore.record?.id ?? '', todos: c.collection('todos') };
}

const suffix = Date.now().toString(36);
const ann = await signUp(`ann-${suffix}@example.com`);
const bob = await signUp(`bob-${suffix}@example.com`);
step('two users signed up and signed in');

const seen: RealtimeEvent[] = [];
const seenByBob: RealtimeEvent[] = [];
await ann.todos.subscribe('*', (e) => seen.push(e));
await bob.todos.subscribe('*', (e) => seenByBob.push(e));

// A 1×1 PNG.
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);
const form = new FormData();
form.append('title', 'Buy oat milk');
form.append('user', ann.id);
form.append('attachment', new Blob([png], { type: 'image/png' }), 'list.png');
const milk = await ann.todos.create(form);
await ann.todos.create({ title: 'Call the bank', user: ann.id });
await bob.todos.create({ title: 'Bob private', user: bob.id });
step('todos created, one with an attachment');

const until = async (done: () => boolean) => {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(done(), 'timed out waiting for a realtime event');
};
await until(() => seen.length >= 2 && seenByBob.length >= 1);
assert.deepEqual(seen.map((e) => e.record['title']).sort(), ['Buy oat milk', 'Call the bank']);
assert.deepEqual(
  seenByBob.map((e) => e.record['title']),
  ['Bob private'],
);
step('realtime delivered each change only to its owner');

const annList = await ann.todos.getFullList();
assert.equal(annList.length, 2);
assert.ok(annList.every((t) => t['user'] === ann.id));
assert.equal((await new MindlogClient(url).collection('todos').getList()).totalItems, 0);
const denied = await bob.todos.getOne(milk.id).catch((e: unknown) => e);
assert.ok(denied instanceof ClientError && denied.status === 404);
const stolen = await bob.todos.create({ title: 'as ann', user: ann.id }).catch((e: unknown) => e);
assert.ok(stolen instanceof ClientError && stolen.status === 400);
step('other users and guests see nothing and cannot write as Ann');

const file = String(milk['attachment']);
const token = await ann.c.getFileToken();
const original = await fetch(ann.c.fileUrl(milk, file, { collection: 'todos', token }));
assert.deepEqual(new Uint8Array(await original.arrayBuffer()), png);
const thumb = await fetch(
  ann.c.fileUrl(milk, file, { collection: 'todos', token, thumb: '96x96' }),
);
assert.equal(thumb.status, 200);
assert.equal(
  (
    await fetch(
      bob.c.fileUrl(milk, file, { collection: 'todos', token: await bob.c.getFileToken() }),
    )
  ).status,
  404,
);
step('attachment and thumbnail served to the owner only');

assert.equal(
  await summarize(url, apiKey, ann.c.authStore.token),
  '2 open: Buy oat milk, Call the bank',
);
assert.equal(await summarize(url, apiKey, bob.c.authStore.token), '1 open: Bob private');
step('the assistant agent read each user’s todos through rules');

await ann.todos.update(milk.id, { done: true });
assert.equal(await summarize(url, apiKey, ann.c.authStore.token), '1 open: Call the bank');
await ann.todos.delete(milk.id);
await until(() => seen.some((e) => e.action === 'delete'));
step('update and delete reached the subscriber');

const log = process.env['DEMO_OTP_LOG'];
if (log !== undefined) {
  const admin = new MindlogClient(url);
  const { token: su } = await admin.send<{ token: string }>('/api/superusers/auth-with-password', {
    method: 'POST',
    body: { email: process.env['ADMIN_EMAIL'], password: process.env['ADMIN_PASSWORD'] },
  });
  const current = await admin.send<{ schema: Record<string, unknown>; version: string }>(
    '/api/collections/users',
    { token: su },
  );
  const schema = { ...current.schema, auth: { otp: { enabled: true } } };
  await admin.send('/api/collections/users', {
    method: 'PATCH',
    token: su,
    body: { schema, version: current.version },
  });
  await new Promise((r) => setTimeout(r, 2100)); // the schema cache
  const email = String(ann.c.authStore.record?.['email']);
  const c = new MindlogClient(url);
  const { otpId } = await c.send<{ otpId: string }>('/api/collections/users/request-otp', {
    method: 'POST',
    body: { email },
  });
  await new Promise((r) => setTimeout(r, 200));
  const code = /Your code is (\d+)/.exec(await readFile(log, 'utf8'))?.[1] ?? '';
  const signed = await c.send<{ record: { verified: boolean } }>(
    '/api/collections/users/auth-with-otp',
    { method: 'POST', body: { otpId, password: code } },
  );
  assert.equal(signed.record.verified, true);
  step('opt-in OTP: signed in with the code from the console mailer');
}

ann.c.disconnect();
bob.c.disconnect();
console.log('phase 9 demo passed');
