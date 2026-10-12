import type { ConnectionCommand } from '../connection-command.js';

/** COMMAND [COUNT | INFO | DOCS | LIST]: answered from the JSON specs. */
export const commandCommand: ConnectionCommand = {
  name: 'COMMAND',
  execute: (ctx, argv) => ctx.server.commands.execute(argv),
};
