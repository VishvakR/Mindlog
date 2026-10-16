/**
 * @mindlog/raft — a pure Raft state machine (PLAN 7): no network, disk, clock
 * or global randomness. The host feeds ticks and messages into a RawNode and
 * drains Readies: persist, send, apply, advance.
 */
export type { RaftConfig, RaftOptions } from './config.js';
export { DEFAULT_RAFT_OPTIONS, validateRaftOptions } from './config.js';
export type { Role } from './raft.js';
export type { ReadState } from './read-only.js';
export type { PeerStatus, RaftBootState, RaftStatus, Ready, SoftState } from './raw-node.js';
export { RawNode, applyToConfState, validateConfChange } from './raw-node.js';
export type { BootstrapPeer } from './bootstrap.js';
export { bootstrapEntries } from './bootstrap.js';
export type { ProgressState } from './tracker/progress.js';
