import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLogger, MemoryMetrics, resolveConfig } from '@mindlog/core';
import type { RunningNode } from '@mindlog/server';
import { startNode } from '@mindlog/server';

/** An in-process single node on a free port over a temporary data directory. */
export async function startTestNode(overrides: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mindlog-compat-'));
  const config = resolveConfig({
    flags: { node: { dataDir }, listen: { resp: { host: '127.0.0.1', port: 0 } }, ...overrides },
  });
  if (!config.ok) throw new Error(config.error.message);
  const started = await startNode(config.value, {
    logger: new MemoryLogger(),
    metrics: new MemoryMetrics(),
  });
  if (!started.ok) throw new Error(started.error.message);
  const node: RunningNode = started.value;
  return {
    node,
    port: node.resp.port,
    async stop() {
      await node.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
