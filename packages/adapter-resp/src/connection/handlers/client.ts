import { parseInteger, replies } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { ClientState } from '../client-state.js';
import { parseClientName } from '../client-name.js';
import type { ConnectionCommand, ConnectionContext } from '../connection-command.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const text = (value: string): KvReply => replies.bulk(encoder.encode(value));

type Subcommand = (ctx: ConnectionContext, args: readonly Uint8Array[]) => KvReply;

function setInfo(ctx: ConnectionContext, args: readonly Uint8Array[]): KvReply {
  const [attribute, value] = args;
  if (!attribute || !value) return replies.errors.arity('client|setinfo');
  const option = decoder.decode(attribute).toUpperCase();
  if (option !== 'LIB-NAME' && option !== 'LIB-VER') {
    return replies.error('INVALID_ARGUMENT', `Unrecognized option '${decoder.decode(attribute)}'`);
  }
  const parsed = parseClientName(value);
  if (typeof parsed !== 'string') {
    return replies.error(
      'INVALID_ARGUMENT',
      `${option} cannot contain spaces, newlines or special characters.`,
    );
  }
  if (option === 'LIB-NAME') ctx.client.libName = parsed;
  else ctx.client.libVersion = parsed;
  return replies.ok();
}

/** CLIENT LIST [TYPE NORMAL] [ID id ...]. */
function list(ctx: ConnectionContext, args: readonly Uint8Array[]): KvReply {
  // A key-bound session sees itself only: other connections may belong to other tenants.
  let clients: ClientState[] = ctx.session.access ? [ctx.client] : ctx.server.clients.list();
  const option = args[0] ? decoder.decode(args[0]).toUpperCase() : undefined;
  if (option === 'TYPE' && args.length === 2) {
    const type = decoder.decode(args[1]).toLowerCase();
    if (!['normal', 'master', 'replica', 'pubsub'].includes(type)) {
      return replies.error('INVALID_ARGUMENT', `Unknown client type '${decoder.decode(args[1])}'`);
    }
    if (type !== 'normal') clients = [];
  } else if (option === 'ID' && args.length >= 2) {
    const ids = new Set<number>();
    for (const arg of args.slice(1)) {
      const id = parseInteger(arg);
      if (id === undefined || id <= 0n)
        return replies.error('INVALID_ARGUMENT', 'Invalid client ID');
      ids.add(Number(id));
    }
    clients = clients.filter((c) => ids.has(c.id));
  } else if (option !== undefined) {
    return replies.errors.syntax();
  }
  const now = ctx.server.clock.now();
  return text(clients.map((c) => `${c.describe(now)}\n`).join(''));
}

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
  ID: (ctx) => replies.integer(ctx.client.id),
  GETNAME: (ctx) => (ctx.client.name ? text(ctx.client.name) : replies.nil()),
  SETNAME(ctx, [name]) {
    const parsed = name ? parseClientName(name) : '';
    if (typeof parsed !== 'string') return parsed;
    ctx.client.name = parsed;
    return replies.ok();
  },
  SETINFO: setInfo,
  INFO: (ctx) => text(`${ctx.client.describe(ctx.server.clock.now())}\n`),
  LIST: list,
};

/** CLIENT ID | GETNAME | SETNAME | SETINFO | INFO | LIST. */
export const clientCommand: ConnectionCommand = {
  name: 'CLIENT',
  execute(ctx, argv) {
    const raw = argv[1] ? decoder.decode(argv[1]) : '';
    const name = raw.toUpperCase();
    const run = SUBCOMMANDS[name];
    const spec = ctx.server.commands.get('CLIENT')?.subcommands?.[name];
    if (!run || !spec) {
      return replies.error('INVALID_ARGUMENT', `unknown subcommand '${raw}'. Try CLIENT HELP.`);
    }
    if (spec.arity >= 0 ? argv.length !== spec.arity : argv.length < -spec.arity) {
      return replies.errors.arity(`client|${name.toLowerCase()}`);
    }
    return run(ctx, argv.slice(2));
  },
};
