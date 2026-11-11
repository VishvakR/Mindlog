import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LevelDbStore, rewrapKeyring } from '@mindlog/storage';
import { loadConfig } from '../bootstrap/load-config.js';
import { masterKeyOf } from '../bootstrap/open-encrypted.js';
import type { MainIo, MainResult } from './io.js';
import { EXIT, formatError } from './io.js';

export const KEYS_USAGE = `Usage: mindlog-server keys rotate-master --new-key-file <path> [options]

Re-wraps every data key of this node under a new master key (ADR-0014).
The current key comes from storage.encryption.masterKey. The server must be stopped.
Afterwards, configure the new key before starting the server.

Options:
  -c, --config <path>    Config file (default: ./mindlog.yaml if present)
      --data-dir <path>  Data directory (node.dataDir)`;

/** The stores a node encrypts: its own log and state, and its PD's, when it has them. */
const STORES = ['raftlog', 'state', join('pd', 'raftlog'), join('pd', 'state')];

/** `mindlog-server keys rotate-master`. */
export async function keysCommand(argv: readonly string[], io: MainIo): Promise<MainResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', short: 'c' },
        'data-dir': { type: 'string' },
        'new-key-file': { type: 'string' },
      },
    });
  } catch {
    io.stderr(`${KEYS_USAGE}\n`);
    return { kind: 'exit', code: EXIT.usage };
  }
  const file = parsed.values['new-key-file'];
  if (parsed.positionals[0] !== 'rotate-master' || parsed.positionals.length !== 1 || !file) {
    io.stderr(`${KEYS_USAGE}\n`);
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
  const current = masterKeyOf(config.value);
  if (!current.ok) {
    io.stderr(formatError(current.error));
    return { kind: 'exit', code: EXIT.config };
  }
  const next = new Uint8Array(
    Buffer.from((await readFile(resolve(io.cwd, file), 'utf8')).trim(), 'base64'),
  );
  if (!current.value || next.length !== 32) {
    io.stderr('Encryption must be on, and the new key must be 32 bytes in base64.\n');
    return { kind: 'exit', code: EXIT.usage };
  }
  for (const name of STORES) {
    const path = resolve(io.cwd, config.value.node.dataDir, name);
    if (!existsSync(path)) continue;
    const store = await LevelDbStore.open(path);
    if (!store.ok) {
      io.stderr(`${name}: ${formatError(store.error)}`);
      return { kind: 'exit', code: EXIT.failure };
    }
    try {
      const done = await rewrapKeyring(store.value, current.value, next);
      if (!done.ok) {
        io.stderr(`${name}: ${formatError(done.error)}`);
        return { kind: 'exit', code: EXIT.failure };
      }
      io.stdout(`${name}: re-wrapped ${String(done.value)} data keys\n`);
    } finally {
      await store.value.close();
    }
  }
  return { kind: 'exit', code: EXIT.ok };
}
