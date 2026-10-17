import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { CommandResult, RangeDescriptor } from '@mindlog/proto';
import {
  CommandResultSchema,
  NodeInfoSchema,
  OperatorSchema,
  RangeDescriptorSchema,
} from '@mindlog/proto';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import {
  FIRST_ALLOCATED_ID,
  nextIdKey,
  nodeKey,
  operatorKey,
  rangeEndKey,
  rangeKey,
  tsoKey,
  versionKey,
} from './pd-keys.js';

const OPERATORS_KEPT = 1000n;

export const integerResult = (n: bigint): CommandResult =>
  create(CommandResultSchema, {
    outcome: { case: 'kv', value: { kind: { case: 'integer', value: n } } },
  });

export const encodeU64 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
};

export const decodeU64 = (bytes: Uint8Array | undefined, fallback = 0n): bigint =>
  bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0) : fallback;

/** `(version, confVersion)` order of epochs: a newer split/merge beats a newer membership. */
function newer(a: RangeDescriptor, b: RangeDescriptor): boolean {
  const [av, bv] = [a.epoch?.version ?? 0n, b.epoch?.version ?? 0n];
  if (av !== bv) return av > bv;
  return (a.epoch?.confVersion ?? 0n) > (b.epoch?.confVersion ?? 0n);
}

async function readRange(reader: KvReader, id: bigint): Promise<RangeDescriptor | undefined> {
  const stored = await reader.get(rangeKey(id));
  return stored ? fromBinary(RangeDescriptorSchema, stored) : undefined;
}

/**
 * Apply handlers of the PD state machine (ADR-0010). They run on every PD
 * replica in log order; all state lives in range-local keys of range 0, so
 * Raft snapshots of the PD group carry it.
 */
export const PD_HANDLERS: readonly ApplyHandler[] = [
  {
    body: 'pdAllocIds',
    async apply({ command, raw }) {
      if (command.body.case !== 'pdAllocIds') return errorResult('INTERNAL', 'wrong body');
      const count = BigInt(command.body.value.count);
      if (count === 0n) return errorResult('INVALID_ARGUMENT', 'count must be positive');
      const first = decodeU64(await raw.reader.get(nextIdKey()), FIRST_ALLOCATED_ID);
      raw.batch.put(nextIdKey(), encodeU64(first + count));
      return integerResult(first);
    },
  },
  {
    body: 'pdPutNode',
    apply({ command, raw }) {
      if (command.body.case !== 'pdPutNode' || !command.body.value.node)
        return Promise.resolve(errorResult('INVALID_ARGUMENT', 'no node'));
      const node = command.body.value.node;
      if (node.nodeId === 0n)
        return Promise.resolve(errorResult('INVALID_ARGUMENT', 'node id must be positive'));
      raw.batch.put(nodeKey(node.nodeId), toBinary(NodeInfoSchema, node));
      return Promise.resolve(integerResult(1n));
    },
  },
  {
    body: 'pdPutRange',
    async apply({ command, raw }) {
      if (command.body.case !== 'pdPutRange' || !command.body.value.range)
        return errorResult('INVALID_ARGUMENT', 'no range');
      const range = command.body.value.range;
      const stored = await readRange(raw.reader, range.rangeId);
      if (stored && !newer(range, stored)) return integerResult(0n);
      if (stored) raw.batch.del(rangeEndKey(stored.endKey, stored.rangeId));
      raw.batch.put(rangeKey(range.rangeId), toBinary(RangeDescriptorSchema, range));
      raw.batch.put(rangeEndKey(range.endKey, range.rangeId), new Uint8Array());
      return integerResult(1n);
    },
  },
  {
    body: 'pdRemoveRange',
    async apply({ command, raw }) {
      if (command.body.case !== 'pdRemoveRange') return errorResult('INTERNAL', 'wrong body');
      const stored = await readRange(raw.reader, command.body.value.rangeId);
      if (!stored) return integerResult(0n);
      raw.batch.del(rangeKey(stored.rangeId));
      raw.batch.del(rangeEndKey(stored.endKey, stored.rangeId));
      return integerResult(1n);
    },
  },
  {
    body: 'pdSetTso',
    async apply({ command, raw }) {
      if (command.body.case !== 'pdSetTso') return errorResult('INTERNAL', 'wrong body');
      const stored = decodeU64(await raw.reader.get(tsoKey()));
      const next = command.body.value.max > stored ? command.body.value.max : stored;
      raw.batch.put(tsoKey(), encodeU64(next));
      return integerResult(next);
    },
  },
  {
    body: 'pdSetVersion',
    async apply({ command, raw }) {
      if (command.body.case !== 'pdSetVersion') return errorResult('INTERNAL', 'wrong body');
      const stored = decodeU64(await raw.reader.get(versionKey()));
      const next = BigInt(command.body.value.version);
      const kept = next > stored ? next : stored;
      raw.batch.put(versionKey(), encodeU64(kept));
      return integerResult(kept);
    },
  },
  {
    body: 'pdRecordOperator',
    apply({ command, raw }) {
      if (command.body.case !== 'pdRecordOperator' || !command.body.value.operator)
        return Promise.resolve(errorResult('INVALID_ARGUMENT', 'no operator'));
      const op = command.body.value.operator;
      raw.batch.put(operatorKey(op.id), toBinary(OperatorSchema, op));
      if (op.id > OPERATORS_KEPT) raw.batch.del(operatorKey(op.id - OPERATORS_KEPT));
      return Promise.resolve(integerResult(1n));
    },
  },
];
