import { parseArgs } from 'node:util';
import { MemoryMetrics, OtelTracer, SystemClock, createLogger } from '@mindlog/core';
import { AdminService } from '@mindlog/services';
import { loadConfig } from '../bootstrap/load-config.js';
import { openNodeCore } from '../bootstrap/open-node-core.js';
import type { MainIo, MainResult } from './io.js';
import { EXIT, formatError } from './io.js';

export const SUPERUSER_USAGE = `Usage: mindlog-server superuser upsert <email> <password> [options]

Creates a dashboard superuser, or resets its password (which revokes its tokens).
The server must be stopped: it holds the data directory open.

Options:
  -c, --config <path>    Config file (default: ./mindlog.yaml if present)
      --data-dir <path>  Data directory (node.dataDir)`;

/** `mindlog-server superuser upsert <email> <password>` (ADR-0024). */
export async function superuserCommand(argv: readonly string[], io: MainIo): Promise<MainResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { config: { type: 'string', short: 'c' }, 'data-dir': { type: 'string' } },
    });
  } catch (cause) {
    io.stderr(
      `mindlog-server: ${cause instanceof Error ? cause.message : String(cause)}\n\n${SUPERUSER_USAGE}\n`,
    );
    return { kind: 'exit', code: EXIT.usage };
  }
  const [action, email, password, ...extra] = parsed.positionals;
  if (action !== 'upsert' || !email || !password || extra.length > 0) {
    io.stderr(`${SUPERUSER_USAGE}\n`);
    return { kind: 'exit', code: EXIT.usage };
  }
  const dataDir = parsed.values['data-dir'];
  const config = await loadConfig({
    cwd: io.cwd,
    env: io.env,
    configPath: parsed.values.config,
    flags: dataDir === undefined ? {} : { node: { dataDir } },
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
    const saved = await new AdminService({ service: core.value.service, clock }).upsertSuperuser({
      email,
      password,
    });
    if (!saved.ok) {
      io.stderr(formatError(saved.error));
      return {
        kind: 'exit',
        code: saved.error.code === 'INVALID_ARGUMENT' ? EXIT.usage : EXIT.failure,
      };
    }
    io.stdout(`Superuser ${saved.value.email} saved.\n`);
    return { kind: 'exit', code: EXIT.ok };
  } finally {
    await core.value.close();
  }
}
