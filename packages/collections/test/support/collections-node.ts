import { create } from '@bufbuild/protobuf';
import type { Command, RecordOp } from '@mindlog/proto';
import { RecordOpKind, RecordOpSchema } from '@mindlog/proto';
import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  SeededRandom,
  UlidGenerator,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import { jobCompleteHandler, jobLeaseHandler, jobRangeHooks } from '@mindlog/jobs';
import { startSingleNode } from '@mindlog/multiraft';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
  wholeKeyspace,
} from '@mindlog/statemachine';
import { MemoryStore, MvccReader } from '@mindlog/storage';
import type { CollectionInput } from '@mindlog/collections';
import {
  decodeRecord,
  recordKey,
  recordWriteHandler,
  schemaChangeHandler,
} from '@mindlog/collections';

export const TENANT = 'acme';
const encoder = new TextEncoder();

/** A one-voter range with the collection and job handlers. */
export async function collectionsNode() {
  const clock = new ManualClock(1_760_000_000_000n);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const handlers = new ApplyHandlerRegistry();
  for (const h of [recordWriteHandler, schemaChangeHandler, jobLeaseHandler, jobCompleteHandler])
    handlers.register(h);
  const store = new MemoryStore();
  const machine = await StateMachine.open({
    store,
    handlers,
    rangeHooks: [jobRangeHooks],
    events: new InMemoryEventBus({ logger, metrics }),
    clock,
    logger,
    metrics,
    rangeId: 1n,
    descriptor: wholeKeyspace(1n),
  });
  const replica = await startSingleNode({
    log: new RaftLogStore(new MemoryStore(), 1n),
    machine,
    clock,
    logger,
    metrics,
    rangeId: 1n,
  });
  const random = new SeededRandom(1n);
  const stamper = new CommandStamper(
    new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
    new UlidGenerator(clock, random),
  );
  const propose = async (command: Command) => {
    const proposed = await replica.propose(command);
    if (!proposed.ok) throw new Error(proposed.error.message);
    return proposed.value.result;
  };
  const schema = (input: CollectionInput | null, expectVersion = 0n) =>
    propose(
      stamper.stamp(TENANT, 'p', {
        case: 'schemaChange',
        value: {
          collection: input?.name ?? '',
          schema: input === null ? new Uint8Array() : encoder.encode(JSON.stringify(input)),
          expectVersion,
        },
      }),
    );
  const drop = (name: string, expectVersion: bigint) =>
    propose(
      stamper.stamp(TENANT, 'p', {
        case: 'schemaChange',
        value: { collection: name, schema: new Uint8Array(), expectVersion },
      }),
    );
  const write = (collection: string, ops: RecordOp[]) =>
    propose(
      stamper.stamp(TENANT, 'p', { case: 'recordWrite', value: { collection, ops, enqueue: [] } }),
    );
  const read = async (collection: string, id: string) => {
    const bytes = await new MvccReader(store).get(recordKey(TENANT, collection, id));
    return bytes === undefined ? undefined : decodeRecord(bytes);
  };
  return { clock, store, replica, stamper, propose, schema, drop, write, read };
}

export function op(
  kind: 'create' | 'update' | 'delete' | 'upsert',
  id: string,
  data?: unknown,
  expectVersion = 0n,
): RecordOp {
  const k = {
    create: RecordOpKind.CREATE,
    update: RecordOpKind.UPDATE,
    delete: RecordOpKind.DELETE,
    upsert: RecordOpKind.UPSERT,
  }[kind];
  return create(RecordOpSchema, {
    kind: k,
    id,
    data: data === undefined ? new Uint8Array() : encoder.encode(JSON.stringify(data)),
    expectVersion,
  });
}
