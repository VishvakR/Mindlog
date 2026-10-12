/**
 * @mindlog/server — the composition root (layer `composition`): the only
 * package that knows concrete adapters and wires them (CLAUDE.md §3.1).
 */
export type { ConfigInputs } from './bootstrap/load-config.js';
export { DEFAULT_CONFIG_FILE, loadConfig } from './bootstrap/load-config.js';
export type { CliArgs } from './cli/args.js';
export { USAGE, parseCliArgs } from './cli/args.js';
export { REDIS_API_VERSION, mindlogVersion, serverInfo } from './bootstrap/server-info.js';
export type { NodeOptions, RunningNode } from './bootstrap/start-node.js';
export { startNode } from './bootstrap/start-node.js';
