import { parseInteger, replies } from '@mindlog/kv';
import type { ConnectionCommand } from '../connection-command.js';

/** SELECT index: Mindlog has one database per tenant, so only 0 exists. */
export const selectCommand: ConnectionCommand = {
  name: 'SELECT',
  execute(_ctx, argv) {
    const index = argv[1] ? parseInteger(argv[1]) : undefined;
    if (index === undefined) return replies.errors.notInteger();
    if (index !== 0n) return replies.error('INVALID_ARGUMENT', 'DB index is out of range');
    return replies.ok();
  },
};

/** QUIT: replies OK, then closes once the reply is written. */
export const quitCommand: ConnectionCommand = {
  name: 'QUIT',
  execute(ctx) {
    ctx.closeAfterReply();
    return replies.ok();
  },
};

/**
 * RESET: discards MULTI and WATCH state, returns to RESP2 and resets
 * authentication, keeping the connection open.
 */
export const resetCommand: ConnectionCommand = {
  name: 'RESET',
  execute(ctx) {
    ctx.resetSession();
    return replies.simple('RESET');
  },
};
