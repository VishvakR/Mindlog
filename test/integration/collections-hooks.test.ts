import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

let node: Awaited<ReturnType<typeof startTestNode>>;
let base = '';
let dir = '';
let admin = '';

const api = async (method: string, path: string, json?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${admin}`,
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};
const until = async (done: () => Promise<boolean>) => {
  for (let i = 0; i < 500; i++) {
    if (await done()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mindlog-hooks-'));
  await mkdir(join(dir, 'hooks'));
  await mkdir(join(dir, 'migrations'));
  await writeFile(
    join(dir, 'migrations', '001_notes.mjs'),
    `export default async (m) => {
       await m.save({ name: 'notes', fields: [{ name: 'title', type: 'text' }, { name: 'slow', type: 'bool' }] });
     };`,
  );
  await writeFile(
    join(dir, 'migrations', '002_notes_tag.mjs'),
    `export default async (m) => {
       await m.save({ name: 'notes', fields: [{ name: 'title', type: 'text' }, { name: 'slow', type: 'bool' }, { name: 'tag', type: 'text' }] });
     };`,
  );
  const log = join(dir, 'after.log');
  await writeFile(
    join(dir, 'hooks', 'main.mjs'),
    `import { appendFileSync } from 'node:fs';
     export default (app) => {
       app.onRecordCreate('notes', 'before', (e) => {
         if (e.body.title === 'forbidden') throw new Error('titles like that are refused');
         if (e.body.title === 'spin') for (;;) {}
         e.body.title = String(e.body.title).toUpperCase();
         e.body.tag = 'hooked';
       });
       app.onRecordCreate('notes', 'after', (e) => { appendFileSync(${JSON.stringify(log)}, 'created ' + e.record.title + '\\n'); });
       app.onRecordDelete('*', 'after', (e) => { appendFileSync(${JSON.stringify(log)}, 'deleted ' + e.collection + '\\n'); });
       app.cronAdd('tick', '* * * * *', () => { appendFileSync(${JSON.stringify(log)}, 'tick\\n'); });
     };`,
  );
  node = await startTestNode({
    limits: { authBurst: 1000 },
    collections: { hooksDir: join(dir, 'hooks'), migrationsDir: join(dir, 'migrations') },
  });
  base = `http://127.0.0.1:${String(node.node.http.port)}`;
  await node.node.admin.upsertSuperuser({ email: 'admin@x.io', password: 'correct horse battery' });
  const login = await api('POST', '/api/superusers/auth-with-password', {
    email: 'admin@x.io',
    password: 'correct horse battery',
  });
  admin = String(login.json['token']);
}, 60_000);

afterAll(async () => {
  await node.stop();
  await rm(dir, { recursive: true, force: true });
});

test('migrations ran in order and are recorded', async () => {
  const notes = await api('GET', '/api/collections/notes');
  expect(
    (notes.json['schema'] as { fields: { name: string }[] }).fields.map((f) => f.name),
  ).toEqual(['title', 'slow', 'tag']);
  const applied = await api('GET', '/api/collections/_migrations/records');
  expect((applied.json['items'] as { file: string }[]).map((i) => i.file).sort()).toEqual([
    '001_notes.mjs',
    '002_notes_tag.mjs',
  ]);
});

test('before hooks change or refuse a write; after hooks run as jobs', async () => {
  const made = await api('POST', '/api/collections/notes/records', { title: 'hello' });
  expect(made.json).toMatchObject({ title: 'HELLO', tag: 'hooked' });
  const refused = await api('POST', '/api/collections/notes/records', { title: 'forbidden' });
  expect([refused.status, refused.json['detail']]).toEqual([400, 'titles like that are refused']);
  const log = () => readFile(join(dir, 'after.log'), 'utf8').catch(() => '');
  expect(await until(async () => (await log()).includes('created HELLO'))).toBe(true);
  await api('DELETE', `/api/collections/notes/records/${String(made.json['id'])}`);
  expect(await until(async () => (await log()).includes('deleted notes'))).toBe(true);
}, 20_000);

test('a runaway hook is stopped, and the next call gets a new worker', async () => {
  const spun = await api('POST', '/api/collections/notes/records', { title: 'spin' });
  expect(spun.json['code']).toBe('DEADLINE_EXCEEDED');
  const after = await api('POST', '/api/collections/notes/records', { title: 'again' });
  expect(after.json['title']).toBe('AGAIN');
}, 20_000);

test('cron is registered once', async () => {
  const crons = await api('GET', '/api/collections/_cron/records');
  expect(
    (crons.json['items'] as { name: string; expr: string }[]).map((c) => [c.name, c.expr]),
  ).toEqual([['tick', '* * * * *']]);
});
