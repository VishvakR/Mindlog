import type { RaftTransport } from './ports.js';

/** Transport of a single-voter range (`--single-node`): there is no peer to reach. */
export const SINGLE_NODE_TRANSPORT: RaftTransport = {
  attach: () => {},
  send: () => {},
  sendSnapshot: () => Promise.resolve(false),
  setPeers: () => {},
};
