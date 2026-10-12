import { arch, release, type } from 'node:os';
import { replies } from '@mindlog/kv';
import type { ConnectionCommand, ConnectionContext } from '../connection-command.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type Section = (ctx: ConnectionContext) => Record<string, string | number>;

const SECTIONS: Readonly<Record<string, Section>> = {
  server: ({ server }) => {
    const uptime = Number((server.clock.now() - server.info.startedAtMs) / 1000n);
    return {
      redis_version: server.info.redisVersion,
      mindlog_version: server.info.mindlogVersion,
      redis_mode: 'standalone',
      os: `${type()} ${release()} ${arch()}`,
      arch_bits: 64,
      process_id: server.info.processId,
      tcp_port: server.info.port,
      uptime_in_seconds: Math.max(0, uptime),
      uptime_in_days: Math.max(0, Math.floor(uptime / 86_400)),
    };
  },
  clients: ({ server }) => ({
    connected_clients: server.clients.size,
    maxclients: server.info.settings.maxclients ?? '0',
  }),
  persistence: () => ({ loading: 0, async_loading: 0 }),
  replication: () => ({ role: 'master', connected_slaves: 0 }),
};

const titled = (name: string): string => `# ${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/**
 * INFO [section ...]: the sections clients probe (`loading`, `role`,
 * `redis_version`). Unknown sections are skipped, as in Valkey.
 */
export const infoCommand: ConnectionCommand = {
  name: 'INFO',
  execute(ctx, argv) {
    const asked = argv.slice(1).map((a) => decoder.decode(a).toLowerCase());
    const everything =
      asked.length === 0 || asked.some((s) => ['all', 'default', 'everything'].includes(s));
    const names = Object.keys(SECTIONS).filter((name) => everything || asked.includes(name));
    const body = names
      .map((name) => {
        const fields = SECTIONS[name]?.(ctx) ?? {};
        const lines = Object.entries(fields).map(([k, v]) => `${k}:${String(v)}`);
        return [titled(name), ...lines].join('\r\n');
      })
      .join('\r\n\r\n');
    return replies.bulk(encoder.encode(body.length > 0 ? `${body}\r\n` : ''));
  },
};
