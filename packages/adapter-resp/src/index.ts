/**
 * @mindlog/adapter-resp — RESP2/RESP3 protocol adapter (PLAN 15.1, layer
 * `interfaces`). Exports only the public API; each module is added as it lands.
 */
export { splitInline } from './protocol/inline-args.js';
export type { ParseEvent, ParserLimits } from './protocol/resp-parser.js';
export { DEFAULT_LIMITS, RespParser } from './protocol/resp-parser.js';
export type { ProtocolVersion } from './protocol/resp-writer.js';
export { RespWriter } from './protocol/resp-writer.js';
export type { CommandArgument, CommandSpec, KeyRange } from './commands/command-spec.js';
export { loadCommandSpecs } from './commands/command-spec.js';
export { CommandTable } from './commands/command-table.js';
export { ClientRegistry, ClientState } from './connection/client-state.js';
export type {
  ConnectionCommand,
  ConnectionContext,
  ServerContext,
  ServerInfo,
} from './connection/connection-command.js';
export { ConnectionCommandRegistry } from './connection/connection-command.js';
export type {
  CloseReason,
  ConnectionDeps,
  ConnectionLimits,
  ConnectionTransport,
} from './connection/connection.js';
export { Connection } from './connection/connection.js';
export { commandCommand } from './connection/handlers/command.js';
export { helloCommand } from './connection/handlers/hello.js';
export {
  quitCommand,
  resetCommand,
  selectCommand,
} from './connection/handlers/session-commands.js';
export { clientCommand } from './connection/handlers/client.js';
export { configCommand } from './connection/handlers/config.js';
export { infoCommand } from './connection/handlers/info.js';
export {
  clusterAddLearnerCommand,
  clusterInfoCommand,
  clusterPromoteCommand,
  clusterRemoveCommand,
  clusterTransferCommand,
} from './connection/handlers/cluster.js';
export { createConnectionCommands } from './connection/handlers/all-handlers.js';
export type { RespServerDeps, RespServerOptions } from './server/resp-server.js';
export { RespServer } from './server/resp-server.js';
