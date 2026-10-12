import { create } from '@bufbuild/protobuf';
import { encodeKey } from '@mindlog/core';
import type { Command } from '@mindlog/proto';
import { CommandResultSchema, CommandSchema } from '@mindlog/proto';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

export const counterKey = (name: string): Uint8Array => {
  const r = encodeKey({ tenant: 't', family: 'k', tuple: [name] });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

/**
 * Test handler for kvWrite: `INCR name` adds 1, `ROLL name` stores a seeded
 * random number, `STAMP name` stores nowMs; anything else is a recorded error.
 */
export const counterHandler: ApplyHandler = {
  body: 'kvWrite',
  async apply({ command, txn, nowMs, random }) {
    if (command.body.case !== 'kvWrite') return errorResult('INTERNAL', 'wrong body');
    const [op, name] = command.body.value.argv.map((a) => decoder.decode(a));
    if (!name) return errorResult('INVALID_ARGUMENT', 'missing name');
    const key = counterKey(name);
    let next: string;
    if (op === 'INCR')
      next = String(Number(decoder.decode((await txn.get(key)) ?? utf8.encode('0'))) + 1);
    else if (op === 'ROLL') next = String(random.nextUint32());
    else if (op === 'STAMP') next = String(nowMs);
    else return errorResult('INVALID_ARGUMENT', `unknown op ${String(op)}`);
    txn.put(key, utf8.encode(next));
    return create(CommandResultSchema, {
      outcome: { case: 'kv', value: { kind: { case: 'bulk', value: utf8.encode(next) } } },
    });
  },
};

let next = 0;

export function writeCommand(argv: string[], requestId = `req-${next++}`, hlc = 0n): Command {
  return create(CommandSchema, {
    requestId: utf8.encode(requestId),
    tenant: 't',
    hlc,
    body: { case: 'kvWrite', value: { argv: argv.map((a) => utf8.encode(a)) } },
  });
}
