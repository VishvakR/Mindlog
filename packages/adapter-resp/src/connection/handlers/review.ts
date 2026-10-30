import { replies } from '@mindlog/kv';
import type { ConflictView } from '@mindlog/memory';
import type { KvReply } from '@mindlog/proto';
import type { ConnectionCommand } from '../connection-command.js';
import {
  answer,
  branchOf,
  leadingBranch,
  caller,
  decoder,
  integerOption,
  isReply,
  memoryReply,
  options,
  scopeOf,
  text,
  timeOf,
  withMemory,
} from './memory.js';

// Conflict review and trust over RESP (ADR-0015, PLAN 13.2 and 13.4).

function conflictReply(c: ConflictView): KvReply {
  return replies.map([
    [text('id'), text(c.id)],
    [text('status'), text(c.status)],
    [text('a'), c.a ? memoryReply(c.a) : replies.nil()],
    [text('b'), c.b ? memoryReply(c.b) : replies.nil()],
    [text('scores'), replies.array(c.scores.map((x) => replies.double(x)))],
    [text('policy'), text(c.policy)],
    [text('origin'), text(c.origin)],
    [text('detected_at'), replies.integer(c.detectedAtMs)],
    ...(c.keep ? [[text('keep'), text(c.keep)] as const] : []),
  ]);
}

/** `MEM.CONFLICTS <scope> [ALL] [LIMIT n] [AFTER id]`: open conflicts unless ALL. */
export const memConflictsCommand: ConnectionCommand = {
  name: 'MEM.CONFLICTS',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const o = options(argv, 2, ['LIMIT', 'AFTER'], ['ALL']);
      if (isReply(o)) return o;
      const limit = integerOption(o.LIMIT);
      if (isReply(limit)) return limit;
      return answer(
        await memory.conflicts(caller(ctx), {
          scope: scopeOf(argv[1]),
          ...(o.ALL ? { status: 'all' as const } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(typeof o.AFTER === 'string' ? { after: o.AFTER } : {}),
        }),
        (r) => replies.array(r.conflicts.map(conflictReply)),
      );
    }),
};

/** `MEM.RESOLVE <scope> <id> KEEP a|b|both [VALID_FROM t]`: the memories it changed. */
export const memResolveCommand: ConnectionCommand = {
  name: 'MEM.RESOLVE',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const o = options(argv, 3, ['KEEP', 'VALID_FROM'], []);
      if (isReply(o)) return o;
      if (typeof o.KEEP !== 'string') return replies.errors.syntax();
      return answer(
        await memory.resolve(caller(ctx), {
          scope: scopeOf(argv[1]),
          id: decoder.decode(argv[2]),
          keep: o.KEEP.toLowerCase() as never,
          ...(typeof o.VALID_FROM === 'string' ? { validFrom: timeOf(o.VALID_FROM) } : {}),
        }),
        (r) => replies.array(r.ids.map(text)),
      );
    }),
};

/** `MEM.TRUST <scope> verified|normal|quarantined [BRANCH name] <id> [id ...]`: how many changed. */
export const memTrustCommand: ConnectionCommand = {
  name: 'MEM.TRUST',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) =>
      answer(
        await memory.trust(caller(ctx), {
          scope: scopeOf(argv[1]),
          trust: decoder.decode(argv[2]).toLowerCase() as never,
          ...branchOf(leadingBranch(argv, 3)[0]),
          ids: leadingBranch(argv, 3)[1].map((a) => decoder.decode(a)),
          reason: `MEM.TRUST by ${ctx.session.principal}`,
        }),
        (r) => replies.integer(r.count),
      ),
    ),
};
