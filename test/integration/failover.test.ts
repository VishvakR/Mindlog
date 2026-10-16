import type { ChildProcessByStdio } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test } from 'vitest';

/**
 * Phase 3 gate (PLAN 24): a 3-node cluster of real processes keeps taking
 * writes when the leader is killed with SIGKILL, within 3 s, and loses no
 * acknowledged write. Writers hit every node (followers forward to the
 * leader). `pnpm test` runs one kill; `FAILOVER_ITERATIONS=10` runs more.
 */
const ITERATIONS = Number(process.env.FAILOVER_ITERATIONS ?? 1);
const ROOT = new URL('../../', import.meta.url).pathname;
const BIN = join(ROOT, 'packages/server/dist/bin.js');
const IDS = [1, 2, 3] as const;

type Server = ChildProcessByStdio<null, Readable, null>;

interface Member {
  readonly id: number;
  process: Server | undefined;
  client: Redis | undefined;
}

let dir: string;
let internalPorts: number[];
const members = new Map<number, Member>();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  });
}

async function start(id: number): Promise<void> {
  const child = spawn(process.execPath, [BIN, '-c', join(dir, `n${id}.yaml`)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  // Keep draining stdout: a full pipe would block the node's logger.
  const started = new Promise<string>((resolve, reject) => {
    lines.on('line', (line) => {
      const entry = JSON.parse(line) as { msg?: string; resp?: string };
      if (entry.msg === 'node started' && entry.resp) resolve(entry.resp);
    });
    child.once('exit', () => {
      reject(new Error(`node ${String(id)} exited before starting`));
    });
  });
  {
    const resp = await started;
    const port = Number(resp.split(':').at(-1));
    const client = new Redis({
      port,
      host: '127.0.0.1',
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    await client.connect();
    members.set(id, { id, process: child, client });
  }
}

let lastTerm = 0;

async function leader(): Promise<number> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    for (const m of members.values()) {
      if (!m.client) continue;
      const info = (await m.client.call('CLUSTER.INFO').catch(() => [])) as unknown[];
      const role = info[info.indexOf('role') + 1];
      if (role === 'leader') {
        lastTerm = Number(info[info.indexOf('term') + 1]);
        return m.id;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no leader elected');
}

/** Waits until every member has applied (nearly) the same index. */
async function caughtUp(): Promise<void> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const applied = await Promise.all(
      [...members.values()].map(async (m) => {
        const info = (await m.client?.call('CLUSTER.INFO').catch(() => [])) as unknown[];
        return Number(info[info.indexOf('applied_index') + 1] ?? -1);
      }),
    );
    if (Math.min(...applied) >= 0 && Math.max(...applied) - Math.min(...applied) < 10) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the restarted node did not catch up');
}

beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'tsc', '-b', 'packages/server'], { cwd: ROOT, stdio: 'inherit' });
  dir = await mkdtemp(join(tmpdir(), 'mindlog-failover-'));
  internalPorts = await Promise.all(IDS.map(() => freePort()));
  const peers = IDS.map(
    (id, i) => `    - { id: ${id}, address: "127.0.0.1:${internalPorts[i]}" }`,
  ).join('\n');
  for (const [i, id] of IDS.entries()) {
    const yaml = [
      `node: { id: node-${id}, raftId: ${id}, dataDir: ${join(dir, `data${id}`)} }`,
      `cluster:\n  peers:\n${peers}`,
      'listen:',
      '  resp: { host: 127.0.0.1, port: 0 }',
      '  http: { host: 127.0.0.1, port: 0 }',
      `  internal: { host: 127.0.0.1, port: ${internalPorts[i]} }`,
      'observability: { logLevel: info }',
    ].join('\n');
    await writeFile(join(dir, `n${id}.yaml`), `${yaml}\n`);
  }
  await Promise.all(IDS.map((id) => start(id)));
}, 120_000);

afterAll(async () => {
  for (const m of members.values()) {
    m.client?.disconnect();
    m.process?.kill('SIGKILL');
  }
  await rm(dir, { recursive: true, force: true });
});

test(
  'killing the leader stops writes for less than 3 s and loses none',
  async () => {
    let acked = 0;
    let indefinite = 0;
    const failovers: number[] = [];
    const terms: number[] = [];
    for (let round = 0; round < ITERATIONS; round++) {
      const victim = await leader();
      const successes: number[] = [];
      let stop = false;
      const writers = [...members.values()].map(async (m) => {
        while (!stop) {
          const client = m.client;
          if (!client) return;
          try {
            await client.incr('failover:counter');
            acked++;
            successes.push(Date.now());
          } catch (cause: unknown) {
            const message = cause instanceof Error ? cause.message : String(cause);
            // TRYAGAIN and BUSY mean "not proposed"; anything else (a timeout, a
            // connection cut by the kill) may still have been applied.
            if (!message.startsWith('TRYAGAIN') && !message.startsWith('BUSY')) indefinite++;
            if (m.id === victim && !message.startsWith('TRYAGAIN')) return;
            await new Promise((r) => setTimeout(r, 5));
          }
        }
      });
      await new Promise((r) => setTimeout(r, 500));
      const killedAt = Date.now();
      const dead = members.get(victim);
      dead?.process?.kill('SIGKILL');
      dead?.client?.disconnect();
      if (dead) dead.client = undefined;
      await new Promise((r) => setTimeout(r, 4000));
      stop = true;
      await Promise.all(writers);
      const firstAfter = successes.find((t) => t > killedAt + 1);
      expect(firstAfter, 'writes resumed').toBeDefined();
      failovers.push((firstAfter ?? Infinity) - killedAt);
      const termBefore = lastTerm;
      await leader();
      terms.push(lastTerm - termBefore);
      // Bring the killed node back and let it catch up, so each round starts healthy.
      await start(victim);
      await caughtUp();
    }
    await leader();
    let value = Number.NaN;
    for (let attempt = 0; attempt < 50 && Number.isNaN(value); attempt++) {
      const client = [...members.values()].find((m) => m.client)?.client;
      value = Number(await client?.get('failover:counter').catch(() => undefined));
      if (Number.isNaN(value)) await new Promise((r) => setTimeout(r, 100));
    }
    console.log(
      `failover: ${failovers.map((ms, i) => `${ms} ms (+${terms[i]} terms)`).join(', ')}; ${acked} acknowledged INCRs, counter ${value}, ${indefinite} indefinite`,
    );
    expect(Math.max(...failovers)).toBeLessThan(3000);
    // Every acknowledged write is there; timed-out ones may or may not be.
    expect(value).toBeGreaterThanOrEqual(acked);
    expect(value).toBeLessThanOrEqual(acked + indefinite);
  },
  30_000 + ITERATIONS * 15_000,
);
