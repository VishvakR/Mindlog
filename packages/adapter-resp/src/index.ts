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
