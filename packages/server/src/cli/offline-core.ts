import { MemoryMetrics, OtelTracer, SystemClock, createLogger } from '@mindlog/core';
import type { Clock } from '@mindlog/core';
import { loadConfig } from '../bootstrap/load-config.js';
import type { NodeCore } from '../bootstrap/open-node-core.js';
import { isSingleNode, openNodeCore } from '../bootstrap/open-node-core.js';
import type { MainIo, MainResult } from './io.js';
import { EXIT, formatError } from './io.js';

const LEADER_WAIT_MS = 10_000;

/**
 * Opens the data directory of a stopped server for an offline command
 * (`superuser`, `apikey`), runs `work`, and closes it. A cluster member waits
 * to hear from (or become) the leader before it can write.
 */
export async function withOfflineCore(
  options: { config?: string | undefined; dataDir?: string | undefined },
  io: MainIo,
  work: (core: NodeCore, clock: Clock) => Promise<MainResult>,
): Promise<MainResult> {
  const config = await loadConfig({
    cwd: io.cwd,
    env: io.env,
    configPath: options.config,
    flags: options.dataDir === undefined ? {} : { node: { dataDir: options.dataDir } },
  });
  if (!config.ok) {
    io.stderr(formatError(config.error));
    return { kind: 'exit', code: EXIT.config };
  }
  const clock = io.node?.clock ?? new SystemClock();
  const core = await openNodeCore(config.value, {
    logger: io.node?.logger ?? createLogger({ level: 'warn', name: 'mindlog' }),
    metrics: new MemoryMetrics(),
    clock,
    tracer: new OtelTracer(),
  });
  if (!core.ok) {
    io.stderr(formatError(core.error));
    io.stderr(
      'Is the server running? Stop it first; only one process may open a data directory.\n',
    );
    return { kind: 'exit', code: EXIT.failure };
  }
  try {
    if (!isSingleNode(config.value)) {
      const known = await Promise.race([
        core.value.replica.leaderKnown().then(() => true),
        new Promise<false>((done) =>
          setTimeout(() => {
            done(false);
          }, LEADER_WAIT_MS).unref(),
        ),
      ]);
      if (!known) {
        io.stderr(
          'mindlog-server: no leader is reachable; start the other cluster members first\n',
        );
        return { kind: 'exit', code: EXIT.failure };
      }
    }
    return await work(core.value, clock);
  } finally {
    await core.value.close();
  }
}
