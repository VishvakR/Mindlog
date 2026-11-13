import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MemoryMetrics, SystemClock, createLogger } from '@mindlog/core';
import { loadBackup } from '../bootstrap/backup-format.js';
import { verifyBackup } from '../bootstrap/backups.js';
import { loadConfig } from '../bootstrap/load-config.js';
import { masterKeyOf } from '../bootstrap/open-encrypted.js';
import { openBlobStore } from '../bootstrap/open-memory.js';
import { openStores } from '../bootstrap/open-node-core.js';
import { restoreInto } from '../bootstrap/restore-backup.js';
import type { MainIo, MainResult } from './io.js';
import { EXIT, formatError } from './io.js';

export const BACKUP_USAGE = `Usage: mindlog-server backup verify <id> [options]
       mindlog-server backup restore <id> --data-dir <new-dir> [options]

verify   Restores backup <id> into memory and checks it (sizes, checksums, coverage).
restore  Writes backup <id> into an empty data directory as a one-node cluster;
         start it with --single-node --data-dir <new-dir> (ADR-0041).

Backups are read from the configured blob store (blob.default); a local one is under the
backed-up node's data directory: node.dataDir, or --from.
Restoring needs the same storage.encryption.masterKey the backup was written with.

Options:
  -c, --config <path>    Config file (default: ./mindlog.yaml if present)
      --from <path>      Data directory of the backed-up node (default node.dataDir)
      --data-dir <path>  restore: the new, empty data directory`;

const usage = (io: MainIo): MainResult => {
  io.stderr(`${BACKUP_USAGE}\n`);
  return { kind: 'exit', code: EXIT.usage };
};

/** `mindlog-server backup verify|restore`. */
export async function backupCommand(argv: readonly string[], io: MainIo): Promise<MainResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', short: 'c' },
        from: { type: 'string' },
        'data-dir': { type: 'string' },
      },
    });
  } catch {
    return usage(io);
  }
  const [action, id] = parsed.positionals;
  const target = parsed.values['data-dir'];
  if (parsed.positionals.length !== 2 || !id) return usage(io);
  if (action !== 'verify' && !(action === 'restore' && target)) return usage(io);
  // The backed-up node's data directory, so a local blob store points at its blobs.
  const from = parsed.values.from;
  const config = await loadConfig({
    cwd: io.cwd,
    env: io.env,
    configPath: parsed.values.config,
    flags: from === undefined ? {} : { node: { dataDir: from } },
  });
  if (!config.ok) {
    io.stderr(formatError(config.error));
    return { kind: 'exit', code: EXIT.config };
  }
  const clock = io.node?.clock ?? new SystemClock();
  const deps = {
    clock,
    logger: io.node?.logger ?? createLogger({ level: 'warn', name: 'mindlog' }),
    metrics: new MemoryMetrics(),
  };
  const blob = openBlobStore(
    {
      ...config.value,
      node: { ...config.value.node, dataDir: resolve(io.cwd, config.value.node.dataDir) },
    },
    clock,
  );
  if (action === 'verify') {
    const checked = await verifyBackup(blob, id, deps);
    if (!checked.ok) {
      io.stderr(formatError(checked.error));
      return { kind: 'exit', code: EXIT.failure };
    }
    io.stdout(`backup ${id}: ${String(checked.value)} ranges restore cleanly\n`);
    return { kind: 'exit', code: EXIT.ok };
  }
  const dir = resolve(io.cwd, target ?? '');
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    io.stderr(`mindlog-server: ${dir} is not empty; restore only into a new data directory\n`);
    return { kind: 'exit', code: EXIT.usage };
  }
  const loaded = await loadBackup(blob, id);
  if (!loaded.ok) {
    io.stderr(formatError(loaded.error));
    return { kind: 'exit', code: EXIT.failure };
  }
  const master = masterKeyOf(config.value);
  if (!master.ok) {
    io.stderr(formatError(master.error));
    return { kind: 'exit', code: EXIT.config };
  }
  const state = await openStores(dir, master.value);
  if (!state.ok) {
    io.stderr(formatError(state.error));
    return { kind: 'exit', code: EXIT.failure };
  }
  const pd = await openStores(join(dir, 'pd'), master.value);
  if (!pd.ok) {
    await Promise.all([state.value.log.close(), state.value.state.close()]);
    io.stderr(formatError(pd.error));
    return { kind: 'exit', code: EXIT.failure };
  }
  try {
    const restored = await restoreInto(
      loaded.value,
      { state: state.value.state, pd: pd.value.state },
      BigInt(config.value.node.raftId),
      deps,
    );
    if (!restored.ok) {
      io.stderr(formatError(restored.error));
      return { kind: 'exit', code: EXIT.failure };
    }
    io.stdout(
      `restored ${String(restored.value.length)} ranges of backup ${id} into ${dir}\n` +
        `start it with: mindlog-server --single-node --data-dir ${dir}\n`,
    );
    return { kind: 'exit', code: EXIT.ok };
  } finally {
    await Promise.all([state.value, pd.value].flatMap((s) => [s.log.close(), s.state.close()]));
  }
}
