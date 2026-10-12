import type { KvCommand } from './kv-command.js';
import { KvCommandRegistry } from './registry.js';
import { counterCommands } from './strings/counters.js';
import { getSetCommands } from './strings/get-set.js';
import { rangeCommands } from './strings/ranges.js';

/** Every KV command Mindlog supports (PLAN 15.1, phase 1 subset). */
export const allKvCommands = (): KvCommand[] => [
  ...getSetCommands,
  ...counterCommands,
  ...rangeCommands,
];

/** A registry with every supported command. */
export const createKvRegistry = (): KvCommandRegistry =>
  new KvCommandRegistry().register(...allKvCommands());
