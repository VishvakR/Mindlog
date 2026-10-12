import type { ChildProcessByStdio } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test } from 'vitest';

/**
 * Phase 1 gate (PLAN 24): kill -9 and restart loses no acknowledged write.
 * Each iteration starts the built server on the same data directory, writes
 * under load, kills it with SIGKILL at a random moment, then verifies every
 * write acknowledged so far on the next start. `pnpm test` runs a few
 * iterations; `pnpm test:durability` runs the gate's 50.
 */
const ITERATIONS = Number(process.env.CRASH_ITERATIONS ?? 3);
const ROOT = new URL('../../', import.meta.url).pathname;
const BIN = join(ROOT, 'packages/server/dist/bin.js');

type Server = ChildProcessByStdio<null, Readable, null>;

interface Started {
  readonly process: Server;
  readonly port: number;
  readonly replayed: number;
}

let dataDir: string;

beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'tsc', '-b', 'packages/server'], { cwd: ROOT, stdio: 'inherit' });
  dataDir = await mkdtemp(join(tmpdir(), 'mindlog-crash-'));
}, 120_000);

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function start(): Promise<Started> {
  const child = spawn(
    process.execPath,
    [BIN, '--single-node', '--host', '127.0.0.1', '--port', '0', '--data-dir', dataDir],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    const entry = JSON.parse(line) as { msg?: string; resp?: string; replayed?: number };
    if (entry.msg === 'node started') {
      lines.on('line', () => undefined); // keep draining stdout
      const port = Number(entry.resp?.split(':').pop());
      return { process: child, port, replayed: entry.replayed ?? 0 };
    }
  }
  throw new Error('mindlog-server exited before it started');
}

/** Everything the server acknowledged so far, across all iterations. */
const acked = { counter: 0, sent: 0, keys: new Map<string, string>(), list: new Set<string>() };

async function verify(port: number): Promise<void> {
  const client = new Redis({ port, host: '127.0.0.1', maxRetriesPerRequest: 0 });
  const counter = Number((await client.get('counter')) ?? '0');
  expect(counter).toBeGreaterThanOrEqual(acked.counter);
  expect(counter).toBeLessThanOrEqual(acked.sent);
  const keys = [...acked.keys.keys()];
  const values = keys.length > 0 ? await client.mget(keys) : [];
  const lost = keys.filter((key, i) => values[i] !== acked.keys.get(key));
  expect(lost).toEqual([]);
  const list = new Set(await client.lrange('log', 0, -1));
  expect([...acked.list].filter((item) => !list.has(item))).toEqual([]);
  client.disconnect();
}

/** Writes in pipelined bursts until the connection dies; records what was acknowledged. */
async function writeUntilKilled(port: number, iteration: number): Promise<void> {
  const client = new Redis({
    port,
    host: '127.0.0.1',
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    enableAutoPipelining: true,
  });
  client.on('error', () => undefined);
  let i = 0;
  let alive = true;
  while (alive) {
    const burst: Promise<unknown>[] = [];
    for (let b = 0; b < 20; b++, i++) {
      const id = `${String(iteration)}:${String(i)}`;
      acked.sent++;
      burst.push(client.incr('counter').then(() => acked.counter++));
      burst.push(client.set(`k:${id}`, id).then(() => acked.keys.set(`k:${id}`, id)));
      burst.push(client.rpush('log', id).then(() => acked.list.add(id)));
    }
    const results = await Promise.allSettled(burst);
    alive = results.every((r) => r.status === 'fulfilled');
  }
  client.disconnect();
}

test(
  `kill -9 loses no acknowledged write (${String(ITERATIONS)} iterations)`,
  { timeout: 20 * 60_000 },
  async () => {
    let replayedTotal = 0;
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const server = await start();
      replayedTotal += server.replayed;
      await verify(server.port);
      const writing = writeUntilKilled(server.port, iteration);
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
      const exited = new Promise((r) => server.process.once('exit', r));
      server.process.kill('SIGKILL');
      await exited;
      await writing;
    }
    const last = await start();
    await verify(last.port);
    last.process.kill('SIGKILL');
    expect(acked.counter).toBeGreaterThan(0);
    process.stdout.write(
      `crash-durability: ${String(ITERATIONS)} kills, ${String(acked.counter)} acknowledged INCRs, ` +
        `${String(acked.keys.size)} SETs, ${String(acked.list.size)} RPUSHes, ${String(replayedTotal)} entries replayed\n`,
    );
  },
);
