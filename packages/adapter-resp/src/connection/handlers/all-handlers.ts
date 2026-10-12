import { ConnectionCommandRegistry } from '../connection-command.js';
import { clientCommand } from './client.js';
import { commandCommand } from './command.js';
import { configCommand } from './config.js';
import { helloCommand } from './hello.js';
import { infoCommand } from './info.js';
import { quitCommand, resetCommand, selectCommand } from './session-commands.js';

/** Every command the RESP adapter answers itself. */
export function createConnectionCommands(): ConnectionCommandRegistry {
  return new ConnectionCommandRegistry([
    helloCommand,
    selectCommand,
    quitCommand,
    resetCommand,
    clientCommand,
    infoCommand,
    configCommand,
    commandCommand,
  ]);
}
