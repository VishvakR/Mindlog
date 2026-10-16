import { create } from '@bufbuild/protobuf';
import { encodeKey } from '@mindlog/core';
import type { Command } from '@mindlog/proto';
import { CommandResultSchema, CommandSchema } from '@mindlog/proto';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import { MvccReader } from '@mindlog/storage';
import type { KvStore } from '@mindlog/storage';

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

const counterKey = (name: string): Uint8Array => {
  const r = encodeKey({ tenant: 't', family: 'k', tuple: [name] });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

/** `INCR name` adds 1 to a counter and replies with the new value. */
export const counterHandler: ApplyHandler = {
  body: 'kvWrite',
  async apply({ command, txn }) {
    if (command.body.case !== 'kvWrite') return errorResult('INTERNAL', 'wrong body');
    const [, name] = command.body.value.argv.map((a) => decoder.decode(a));
    if (!name) return errorResult('INVALID_ARGUMENT', 'missing name');
    const key = counterKey(name);
    const next = String(Number(decoder.decode((await txn.get(key)) ?? utf8.encode('0'))) + 1);
    txn.put(key, utf8.encode(next));
    return create(CommandResultSchema, {
      outcome: { case: 'kv', value: { kind: { case: 'bulk', value: utf8.encode(next) } } },
    });
  },
};

let next = 0;

export function incr(name: string, requestId = `req-${next++}`): Command {
  return create(CommandSchema, {
    requestId: utf8.encode(requestId),
    tenant: 't',
    body: { case: 'kvWrite', value: { argv: [utf8.encode('INCR'), utf8.encode(name)] } },
  });
}

export async function counter(store: KvStore, name: string): Promise<number> {
  const value = await new MvccReader(store).get(counterKey(name));
  return value ? Number(decoder.decode(value)) : 0;
}
