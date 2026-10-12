import type { Result } from '@mindlog/core';
import { err, ok } from '@mindlog/core';
import { parseInteger, replies } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { ProtocolVersion } from '../../protocol/resp-writer.js';
import { parseClientName } from '../client-name.js';
import type { ConnectionCommand, ConnectionContext } from '../connection-command.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const text = (value: string): KvReply => replies.bulk(encoder.encode(value));

interface HelloOptions {
  protocol?: ProtocolVersion;
  auth?: readonly [string, string];
  name?: string;
}

function parseOptions(argv: readonly Uint8Array[]): Result<HelloOptions, KvReply> {
  const options: HelloOptions = {};
  const version = argv[1];
  if (version === undefined) return ok(options);
  const parsed = parseInteger(version);
  if (parsed === undefined) {
    return err(
      replies.error('INVALID_ARGUMENT', 'Protocol version is not an integer or out of range'),
    );
  }
  if (parsed !== 2n && parsed !== 3n) {
    return err(replies.error('UNSUPPORTED_PROTOCOL', 'unsupported protocol version'));
  }
  options.protocol = parsed === 2n ? 2 : 3;
  for (let i = 2; i < argv.length; i++) {
    const option = decoder.decode(argv[i]).toUpperCase();
    const left = argv.length - i - 1;
    const [a, b] = [argv[i + 1], argv[i + 2]];
    if (option === 'AUTH' && left >= 2 && a && b) {
      options.auth = [decoder.decode(a), decoder.decode(b)];
      i += 2;
    } else if (option === 'SETNAME' && left >= 1 && a) {
      const name = parseClientName(a);
      if (typeof name !== 'string') return err(name);
      options.name = name;
      i += 1;
    } else {
      return err(
        replies.error(
          'INVALID_ARGUMENT',
          `Syntax error in HELLO option '${decoder.decode(argv[i])}'`,
        ),
      );
    }
  }
  return ok(options);
}

function helloReply(ctx: ConnectionContext): KvReply {
  const { info } = ctx.server;
  return replies.map([
    [text('server'), text('mindlog')],
    [text('version'), text(info.redisVersion)],
    [text('proto'), replies.integer(ctx.client.protocol)],
    [text('id'), replies.integer(ctx.client.id)],
    [text('mode'), text('standalone')],
    [text('role'), text('master')],
    [text('modules'), replies.array([])],
  ]);
}

/**
 * HELLO [protover [AUTH user pass] [SETNAME name]]: switches between RESP2
 * and RESP3, optionally authenticating; the reply already uses the new
 * protocol. Allowed before authentication (spec flag NO_AUTH).
 */
export const helloCommand: ConnectionCommand = {
  name: 'HELLO',
  execute(ctx, argv) {
    const parsed = parseOptions(argv);
    if (!parsed.ok) return parsed.error;
    const options = parsed.value;
    if (options.auth) {
      const result = ctx.server.service.authenticate(ctx.session, ...options.auth);
      if (result.kind.case === 'error') return result;
    }
    if (!ctx.session.authenticated) {
      return replies.error(
        'UNAUTHENTICATED',
        'HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time',
      );
    }
    if (options.protocol !== undefined) ctx.client.protocol = options.protocol;
    if (options.name !== undefined) ctx.client.name = options.name;
    return helloReply(ctx);
  },
};
