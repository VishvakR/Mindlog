import { parseArgs } from 'node:util';
import { ApiKeyService } from '@mindlog/services';
import type { MainIo, MainResult } from './io.js';
import { EXIT, formatError } from './io.js';
import { withOfflineCore } from './offline-core.js';

export const APIKEY_USAGE = `Usage: mindlog-server apikey create --tenant <tenant> --name <name> [--user <user>] [options]
       mindlog-server apikey list [options]
       mindlog-server apikey revoke <id> [options]

API keys let agents use memory over MCP (PLAN 15.2). A key pinned to --user reaches only that
user's memory; without it, every user of the tenant. The secret is printed once.
The server must be stopped: it holds the data directory open. A running node manages keys
through POST /api/admin/api-keys.

Options:
  -c, --config <path>    Config file (default: ./mindlog.yaml if present)
      --data-dir <path>  Data directory (node.dataDir)`;

/** `mindlog-server apikey create|list|revoke`. */
export async function apikeyCommand(argv: readonly string[], io: MainIo): Promise<MainResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', short: 'c' },
        'data-dir': { type: 'string' },
        tenant: { type: 'string' },
        user: { type: 'string' },
        name: { type: 'string' },
      },
    });
  } catch (cause) {
    io.stderr(
      `mindlog-server: ${cause instanceof Error ? cause.message : String(cause)}\n\n${APIKEY_USAGE}\n`,
    );
    return { kind: 'exit', code: EXIT.usage };
  }
  const [action, id, ...extra] = parsed.positionals;
  const { tenant, user, name } = parsed.values;
  const usage = (): MainResult => {
    io.stderr(`${APIKEY_USAGE}\n`);
    return { kind: 'exit', code: EXIT.usage };
  };
  if (extra.length > 0) return usage();
  if (action === 'create' && (!tenant || !name || id)) return usage();
  if (action === 'revoke' && !id) return usage();
  if (action !== 'create' && action !== 'list' && action !== 'revoke') return usage();
  return withOfflineCore(
    { config: parsed.values.config, dataDir: parsed.values['data-dir'] },
    io,
    async (core, clock) => {
      const keys = new ApiKeyService({ service: core.service, clock });
      if (action === 'create') {
        const created = await keys.create({
          tenant: tenant ?? '',
          name: name ?? '',
          ...(user ? { user } : {}),
        });
        if (!created.ok) {
          io.stderr(formatError(created.error));
          return {
            kind: 'exit',
            code: created.error.code === 'INVALID_ARGUMENT' ? EXIT.usage : EXIT.failure,
          };
        }
        io.stdout(
          `API key id ${created.value.id} for tenant ${created.value.tenant}` +
            `${created.value.user ? `, user ${created.value.user}` : ''}:\n${created.value.key}\n` +
            'Store it now; it is not shown again.\n',
        );
        return { kind: 'exit', code: EXIT.ok };
      }
      if (action === 'list') {
        const listed = await keys.list();
        if (!listed.ok) {
          io.stderr(formatError(listed.error));
          return { kind: 'exit', code: EXIT.failure };
        }
        for (const k of listed.value)
          io.stdout(`${k.id}  ${k.tenant}  ${k.user ?? '*'}  ${k.name}  ${k.created}\n`);
        return { kind: 'exit', code: EXIT.ok };
      }
      const revoked = await keys.revoke(id ?? '');
      if (!revoked.ok || !revoked.value) {
        io.stderr(
          revoked.ok ? `mindlog-server: no API key ${id ?? ''}\n` : formatError(revoked.error),
        );
        return { kind: 'exit', code: EXIT.failure };
      }
      io.stdout(`API key ${id ?? ''} revoked.\n`);
      return { kind: 'exit', code: EXIT.ok };
    },
  );
}
