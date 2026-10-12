import { textBytes } from '../../model/numbers.js';
import { array, bulk, errors, simple } from '../../model/replies.js';
import type { KvCommand } from '../kv-command.js';

const PING: KvCommand = {
  name: 'PING',
  arity: -1,
  flags: ['readonly', 'fast'],
  execute(_ks, [message, extra]) {
    if (extra) return Promise.resolve(errors.arity('ping'));
    return Promise.resolve(message ? bulk(message) : simple('PONG'));
  },
};

const ECHO: KvCommand = {
  name: 'ECHO',
  arity: 2,
  flags: ['readonly', 'fast'],
  execute: (_ks, [message]) => Promise.resolve(bulk(message as Uint8Array)),
};

/** Unix seconds and microseconds; inside apply this is the command's HLC time. */
const TIME: KvCommand = {
  name: 'TIME',
  arity: 1,
  flags: ['readonly', 'fast'],
  execute(ks) {
    const ms = ks.context.nowMs;
    return Promise.resolve(
      array([
        bulk(textBytes((ms / 1000n).toString())),
        bulk(textBytes(((ms % 1000n) * 1000n).toString())),
      ]),
    );
  },
};

export const serverCommands: KvCommand[] = [PING, ECHO, TIME];
