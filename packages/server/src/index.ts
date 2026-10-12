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
export { DEFAULT_DASHBOARD_DIR, redactedSettings, startNode } from './bootstrap/start-node.js';
export type { NodeCore } from './bootstrap/open-node-core.js';
export { openNodeCore } from './bootstrap/open-node-core.js';
export type { MainIo, MainResult } from './cli/io.js';
export { EXIT, formatError } from './cli/io.js';
export { main } from './cli/main.js';
