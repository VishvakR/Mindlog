import type { ServedModels } from '@mindlog/models-client';
import { FakeModels, serveModels } from '@mindlog/models-client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

/** PLAN 8.5 / ADR-0039: a scope that outgrows its threshold splits, and still answers as one. */

let models: ServedModels;
let node: Awaited<ReturnType<typeof startTestNode>>;
let base = '';
let root = '';

async function call(path: string, body: unknown, token = root) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function until(check: () => Promise<boolean>, what: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const COOKING = ['bake', 'bread', 'flour', 'oven', 'yeast', 'dough', 'butter', 'sugar'];
const SPACE = ['orbit', 'planet', 'comet', 'telescope', 'galaxy', 'nebula', 'rocket', 'moon'];
const text = (words: string[], i: number) =>
  `${words[i % words.length] ?? ''} ${words[(i + 3) % words.length] ?? ''} ${words[(i + 5) % words.length] ?? ''} note ${String(i)}`;

const scope = { user: 'ann' };
const N = 30;

beforeAll(async () => {
  models = await serveModels(new FakeModels());
  node = await startTestNode({
    limits: { authBurst: 10_000 },
    models: { endpoint: models.address },
    memory: {
      split: { maxMemories: 40 },
      consolidation: { tickMs: 1000, idleMs: 0 },
    },
  });
  base = `http://127.0.0.1:${String(node.node.http.port)}`;
  await node.node.admin.upsertSuperuser({
    email: 'root@example.com',
    password: 'correct horse battery',
  });
  const login = await fetch(`${base}/api/superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'root@example.com', password: 'correct horse battery' }),
  });
  root = ((await login.json()) as { token: string }).token;
  for (let i = 0; i < N; i++) {
    for (const words of [COOKING, SPACE]) {
      const r = await call('/api/memory/remember', {
        scope,
        content: text(words, i),
        kind: 'semantic',
      });
      expect(r.status).toBe(200);
    }
  }
}, 120_000);

afterAll(async () => {
  await node.stop();
  await models.close();
});

describe('a split scope', () => {
  test('splits in two and moves memories to the new cluster', { timeout: 90_000 }, async () => {
    await until(async () => {
      const jobs = await call('/api/memory/jobs', { scope });
      const lifecycle = jobs.body.lifecycle as { clusters?: number; hot?: number } | undefined;
      const moving = (jobs.body.jobs as Array<{ kind: string }>).some(
        (j) => j.kind === 'memory.split',
      );
      return (lifecycle?.clusters ?? 1) >= 2 && lifecycle?.hot === 2 * N && !moving;
    }, 'the split');
  });

  test('lists every memory once, across clusters, by cursor', async () => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await call('/api/memory/list', { scope, limit: 25, ...(after ? { after } : {}) });
      expect(r.status).toBe(200);
      seen.push(...(r.body.memories as Array<{ id: string; user: string }>).map((m) => m.id));
      for (const m of r.body.memories as Array<{ user: string }>) expect(m.user).toBe('ann');
      after = r.body.next as string | undefined;
      if (!after) break;
    }
    expect(seen).toHaveLength(2 * N);
    expect(new Set(seen).size).toBe(2 * N);
  });

  test('recall finds memories in either cluster', async () => {
    for (const [query, words] of [
      ['bread flour oven', COOKING],
      ['planet orbit comet', SPACE],
    ] as const) {
      const r = await call('/api/memory/recall', { scope, query, k: 5 });
      expect(r.status).toBe(200);
      const items = r.body.items as Array<{ memory: { text: string } }>;
      expect(items.length).toBeGreaterThan(0);
      expect(words.some((w) => items[0]?.memory.text.includes(w))).toBe(true);
    }
  });

  test('get, forget and history reach whichever cluster holds the memory', async () => {
    const listed = await call('/api/memory/list', { scope, limit: 100 });
    const ids = (listed.body.memories as Array<{ id: string }>).map((m) => m.id);
    const last = ids.at(-1) as string;
    const got = await call('/api/memory/get', { scope, id: last });
    expect((got.body as { id?: string }).id).toBe(last);
    const history = await call('/api/memory/history', { scope, id: last });
    expect(history.status).toBe(200);
    const forgot = await call('/api/memory/forget', { scope, ids: [last], reason: 'test' });
    expect(forgot.body.count).toBe(1);
    const after = await call('/api/memory/list', { scope, limit: 100 });
    let total = (after.body.memories as unknown[]).length;
    let next = after.body.next as string | undefined;
    while (next) {
      const more = await call('/api/memory/list', { scope, limit: 100, after: next });
      total += (more.body.memories as unknown[]).length;
      next = more.body.next as string | undefined;
    }
    expect(total).toBe(2 * N - 1);
  });

  test('branches and the semantic cache are refused on a split scope', async () => {
    const branch = await call('/api/memory/branch', { scope, name: 'plan' });
    expect(branch.status).toBe(400);
  });
});
