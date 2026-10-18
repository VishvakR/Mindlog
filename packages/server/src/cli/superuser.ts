import { parseArgs } from 'node:util';
import { AdminService } from '@mindlog/services';
import type { MainIo, MainResult } from './io.js';
import { EXIT, formatError } from './io.js';
import { withOfflineCore } from './offline-core.js';

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
  return withOfflineCore(
    { config: parsed.values.config, dataDir: parsed.values['data-dir'] },
    io,
    async (core, clock) => {
      const saved = await new AdminService({ service: core.service, clock }).upsertSuperuser({
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
    },
  );
}
