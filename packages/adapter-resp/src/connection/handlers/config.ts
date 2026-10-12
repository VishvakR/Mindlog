import { globMatch, replies } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { ConnectionCommand } from '../connection-command.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const text = (value: string): KvReply => replies.bulk(encoder.encode(value));

/**
 * CONFIG GET pattern [pattern ...]: read-only view of the settings clients
 * and tools ask about. Configuration changes go through `mindlog.yaml`.
 */
export const configCommand: ConnectionCommand = {
  name: 'CONFIG',
  execute(ctx, argv) {
    const raw = argv[1] ? decoder.decode(argv[1]) : '';
    if (raw.toUpperCase() !== 'GET') {
      return replies.error('INVALID_ARGUMENT', `unknown subcommand '${raw}'. Try CONFIG HELP.`);
    }
    if (argv.length < 3) return replies.errors.arity('config|get');
    const patterns = argv.slice(2).map((p) => encoder.encode(decoder.decode(p).toLowerCase()));
    const entries = Object.entries(ctx.server.info.settings).filter(([name]) =>
      patterns.some((p) => globMatch(p, encoder.encode(name))),
    );
    return replies.map(entries.map(([name, value]) => [text(name), text(value)] as const));
  },
};
