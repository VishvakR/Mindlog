import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryApi, MindlogClient } from '@mindlog/sdk';
import { EmbeddedReplica } from '@mindlog/sdk/replica';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { cuttableProxy } from '../support/cuttable-proxy.js';
import { startTestNode } from '../support/node.js';

/** PLAN 24 phase 10 deliverable: an agent with an embedded replica keeps reading while the network is cut. */

let node: Awaited<ReturnType<typeof startTestNode>>;
let proxy: Awaited<ReturnType<typeof cuttableProxy>>;
let direct: MemoryApi;
let key = '';
let dir = '';

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  node = await startTestNode({ limits: { authBurst: 10_000 } });
  const made = await node.node.apiKeys.create({
    tenant: 'default',
    name: 'agent',
    role: 'developer',
  });
  if (!made.ok) throw new Error(made.error.message);
  key = made.value.key;
  const base = `http://127.0.0.1:${String(node.node.http.port)}`;
  proxy = await cuttableProxy(node.node.http.port);
  direct = new MemoryApi(new MindlogClient(base), 'ann', key);
  dir = await mkdtemp(join(tmpdir(), 'mindlog-replica-'));
});

afterAll(async () => {
  await proxy.close();
  await node.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('the TypeScript SDK', () => {
  test('a request id makes a write apply once', async () => {
    const a = await direct.remember('Ann prefers tea.', { requestId: 'once-1' });
    const b = await direct.remember('Ann prefers tea.', { requestId: 'once-1' });
    expect(b.ids).toEqual(a.ids);
    const all = await direct.list({ limit: 100 });
    expect(all.memories.filter((m) => m.text === 'Ann prefers tea.')).toHaveLength(1);
  });

  test('recall, getMany and forget', async () => {
    const r = await direct.remember('Ann flies to Lisbon on Friday.');
    expect((await direct.getMany(r.ids)).map((m) => m.id)).toEqual(r.ids);
    expect((await direct.recall('Lisbon flight')).items.length).toBeGreaterThan(0);
    expect((await direct.forget(r.ids)).count).toBe(1);
  });
});

interface Step {
  readonly do: string;
  readonly text?: string;
  readonly query?: string;
  readonly top?: string;
  readonly contains?: string;
  readonly queued?: boolean;
  readonly pending?: boolean;
}

const scenario = JSON.parse(
  readFileSync(new URL('../scenarios/replica-offline.json', import.meta.url), 'utf8'),
) as { user: string; steps: Step[] };

/** Runs one step of the shared scenario against `replica`. */
async function step(replica: EmbeddedReplica, s: Step): Promise<void> {
  const { user } = scenario;
  const has = (text = '') => replica.list(user).filter((m) => m.text.includes(text));
  switch (s.do) {
    case 'waitOnline':
      return until(() => replica.online, 'the replica to connect');
    case 'waitOffline':
      return until(() => !replica.online, 'the replica to notice the cut');
    case 'waitDrained':
      return until(() => replica.online && replica.queued === 0, 'the queue to drain');
    case 'waitLocal':
      return until(() => has(s.contains).length > 0, `"${s.contains ?? ''}" locally`);
    case 'cut':
      proxy.cut();
      return;
    case 'restore':
      proxy.restore();
      return;
    case 'remote':
      await direct.remember(s.text ?? '');
      return;
    case 'remember': {
      const done = await replica.remember(user, s.text ?? '');
      expect(done.queued).toBe(s.queued);
      return;
    }
    case 'recall': {
      const top = (await replica.recall(user, s.query ?? ''))[0];
      expect(top?.text).toContain(s.top);
      if (s.pending !== undefined) expect(top?.pending).toBe(s.pending);
      return;
    }
    case 'localOnce': {
      await replica.settled();
      const found = has(s.contains);
      expect(found).toHaveLength(1);
      expect(found[0]?.pending).toBe(false);
      return;
    }
    case 'serverOnce': {
      const server = await direct.list({ limit: 200 });
      expect(server.memories.filter((m) => m.text.includes(s.contains ?? ''))).toHaveLength(1);
      return;
    }
    default:
      throw new Error(`unknown step ${s.do}`);
  }
}

describe('an embedded replica', () => {
  test('runs the shared offline scenario', { timeout: 60_000 }, async () => {
    const replica = EmbeddedReplica.open(new MindlogClient(proxy.url), {
      path: join(dir, 'replica.db'),
      users: [scenario.user],
      apiKey: key,
    });
    try {
      for (const s of scenario.steps) await step(replica, s);
    } finally {
      replica.close();
    }
  });

  test('reopening the file keeps the copy and resumes from its cursor', async () => {
    proxy.cut();
    const replica = EmbeddedReplica.open(new MindlogClient(proxy.url), {
      path: join(dir, 'replica.db'),
      users: ['ann'],
      apiKey: key,
    });
    try {
      expect(replica.list('ann').some((m) => m.text.includes('passport'))).toBe(true);
      proxy.restore();
      await until(() => replica.online, 'the reconnect');
    } finally {
      replica.close();
    }
  });
});
