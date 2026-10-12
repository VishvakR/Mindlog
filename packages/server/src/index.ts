/**
 * @mindlog/server — the composition root (layer `composition`): the only
 * package that knows concrete adapters and wires them (CLAUDE.md §3.1).
 */
export type { ConfigInputs } from './bootstrap/load-config.js';
export { DEFAULT_CONFIG_FILE, loadConfig } from './bootstrap/load-config.js';
