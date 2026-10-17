import type { Clock, Counter, Hlc, Histogram, Logger, Metrics } from '@mindlog/core';
import { SeededRandom, hlcPhysical, prefixRange } from '@mindlog/core';
import type { EventBus } from '@mindlog/eventbus';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type {
  Command,
  CommandResult,
  ConfState,
  KeyValue,
  RangeDescriptor,
  SnapshotMeta,
} from '@mindlog/proto';
import {
  ConfStateSchema,
  RangeDescriptorSchema,
  RangeEpochSchema,
  SnapshotMetaSchema,
} from '@mindlog/proto';
import type { KvReader, KvStore, WriteBatch } from '@mindlog/storage';
import { MvccTxn } from '@mindlog/storage';
import { IdempotencyTable } from '../system/idempotency-table.js';
import {
  appliedIndexKey,
  confStateKey,
  lastVersionKey,
  rangeDescriptorKey,
  rangeLocalPrefix,
} from '../system/system-keys.js';
import { SpanReader, spanIntervals, wholeKeyspace } from '../range/span.js';
import type { ApplyHandlerRegistry } from './apply-handler-registry.js';
import { errorResult } from './command-results.js';

export interface StateMachineDeps {
  /** The state store (not the log store, ADR-0005). */
  readonly store: KvStore;
  readonly handlers: ApplyHandlerRegistry;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly rangeId?: bigint;
  /** Descriptor to start from when the store has none (default: the whole keyspace). */
  readonly descriptor?: RangeDescriptor;
}

/** Applied index and the term of that entry (ADR-0026). */
export interface AppliedPoint {
  readonly index: bigint;
  readonly term: bigint;
}

const encodeApplied = (point: AppliedPoint): Uint8Array => {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, point.index);
  view.setBigUint64(8, point.term);
  return out;
};

const decodeApplied = (bytes: Uint8Array): AppliedPoint => {
  if (bytes.length !== 16) throw new Error('applied index record is corrupt');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { index: view.getBigUint64(0), term: view.getBigUint64(8) };
};

/** A consistent view of the state store for streaming to a follower. */
export interface StateSnapshot {
  readonly meta: SnapshotMeta;
  /** Every key/value of the view, in chunks of at most `chunkBytes`. */
  chunks(chunkBytes: number): AsyncIterable<KeyValue[]>;
  release(): Promise<void>;
}

const encodeU64 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
};

const decodeU64 = (bytes: Uint8Array): bigint =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0);

interface RangeState {
  readonly applied: AppliedPoint;
  readonly confState: ConfState;
  readonly descriptor: RangeDescriptor | undefined;
  readonly lastVersion: bigint;
}

/**
 * Applies committed commands in log order (PLAN 6.2). Each apply is one write
 * batch holding the handler's MVCC changes, the idempotency record, the range
 * version and the new applied index, so they never disagree. Handlers see
 * only deterministic inputs and only their range's keys; a thrown error stops
 * the replica (fail-stop).
 */
export class StateMachine {
  readonly #deps: StateMachineDeps;
  readonly #rangeId: bigint;
  readonly #idempotency: IdempotencyTable;
  readonly #latency: Histogram;
  readonly #appliedTotal: Counter;
  #applied: AppliedPoint;
  #confState: ConfState;
  #descriptor: RangeDescriptor;
  #lastVersion: bigint;
  #appliedHlc = 0n;

  private constructor(deps: StateMachineDeps, rangeId: bigint, state: RangeState) {
    this.#deps = deps;
    this.#rangeId = rangeId;
    this.#idempotency = new IdempotencyTable(deps.store, rangeId);
    this.#applied = state.applied;
    this.#confState = state.confState;
    this.#descriptor = state.descriptor ?? deps.descriptor ?? wholeKeyspace(rangeId);
    this.#lastVersion = state.lastVersion;
    this.#latency = deps.metrics.histogram({
      name: 'mindlog_statemachine_apply_latency_seconds',
      help: 'Time to apply one committed command',
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
    });
    this.#appliedTotal = deps.metrics.counter({
      name: 'mindlog_statemachine_applied_total',
      help: 'Commands applied, by body kind',
      labelNames: ['body'],
    });
  }

  static async open(deps: StateMachineDeps): Promise<StateMachine> {
    const rangeId = deps.rangeId ?? 1n;
    const state = await readRangeState(deps.store, rangeId);
    const machine = new StateMachine(deps, rangeId, state);
    if (!state.descriptor) {
      const batch = deps.store.batch();
      batch.put(rangeDescriptorKey(rangeId), toBinary(RangeDescriptorSchema, machine.#descriptor));
      await batch.write();
    }
    return machine;
  }

  get rangeId(): bigint {
    return this.#rangeId;
  }

  get appliedIndex(): bigint {
    return this.#applied.index;
  }

  get applied(): AppliedPoint {
    return this.#applied;
  }

  /** Membership as of the applied index (ADR-0006). */
  get confState(): ConfState {
    return this.#confState;
  }

  /** The range's span and epoch as of the applied index (ADR-0009). */
  get descriptor(): RangeDescriptor {
    return this.#descriptor;
  }

  /** Newest MVCC version this range assigned (ADR-0027). */
  get lastVersion(): bigint {
    return this.#lastVersion;
  }

  /** HLC of the last applied command, for bounded-staleness reads (ADR-0007). */
  get appliedHlc(): bigint {
    return this.#appliedHlc;
  }

  /**
   * Makes everything applied so far durable (fsync). The log may be compacted
   * only up to an index that has been flushed (CLAUDE.md rule 7).
   */
  async flush(): Promise<AppliedPoint> {
    const applied = this.#applied;
    const batch = this.#deps.store.batch();
    batch.put(appliedIndexKey(this.#rangeId), encodeApplied(applied));
    await batch.write({ sync: true });
    return applied;
  }

  /** Applies the command of log entry (index, term). */
  async apply(index: bigint, term: bigint, command: Command): Promise<CommandResult> {
    this.#checkOrder(index);
    const started = this.#deps.clock.monotonic();
    const batch = this.#deps.store.batch();
    let result = await this.#idempotency.lookup(command.requestId);
    if (!result) {
      const version = command.hlc > this.#lastVersion ? command.hlc : this.#lastVersion + 1n;
      result = await this.#execute(index, version, command, batch);
      this.#idempotency.record(batch, command.requestId, result, version);
      batch.put(lastVersionKey(this.#rangeId), encodeU64(version));
      this.#lastVersion = version;
    }
    await this.#commit(batch, { index, term });
    if (command.hlc > this.#appliedHlc) this.#appliedHlc = command.hlc;

    const body = command.body.case ?? 'none';
    this.#appliedTotal.inc(1, { body });
    this.#latency.observe(Number(this.#deps.clock.monotonic() - started) / 1e9);
    this.#deps.events.publish({ type: 'CommandApplied', rangeId: this.#rangeId, index, command });
    return result;
  }

  /** Applies an entry with no command (the leader's no-op). */
  async applyEmpty(index: bigint, term: bigint): Promise<void> {
    this.#checkOrder(index);
    await this.#commit(this.#deps.store.batch(), { index, term });
  }

  /** Records the membership that a configuration entry produced (ADR-0006). */
  async applyConfState(index: bigint, term: bigint, confState: ConfState): Promise<void> {
    this.#checkOrder(index);
    const batch = this.#deps.store.batch();
    batch.put(confStateKey(this.#rangeId), toBinary(ConfStateSchema, confState));
    const epoch = this.#descriptor.epoch ?? create(RangeEpochSchema, {});
    const descriptor = create(RangeDescriptorSchema, {
      ...this.#descriptor,
      epoch: create(RangeEpochSchema, { ...epoch, confVersion: epoch.confVersion + 1n }),
    });
    batch.put(rangeDescriptorKey(this.#rangeId), toBinary(RangeDescriptorSchema, descriptor));
    await this.#commit(batch, { index, term });
    this.#confState = confState;
    this.#descriptor = descriptor;
  }

  /**
   * A consistent view of the range: its keys and its range-local `$node`
   * state (ADR-0028), labelled with its applied point.
   */
  async snapshot(): Promise<StateSnapshot> {
    const view = await this.#deps.store.snapshot();
    const state = await readRangeState(view, this.#rangeId);
    const parts = this.#ownKeys(state.descriptor ?? this.#descriptor);
    return {
      meta: create(SnapshotMetaSchema, {
        index: state.applied.index,
        term: state.applied.term,
        confState: state.confState,
      }),
      async *chunks(chunkBytes: number) {
        let chunk: KeyValue[] = [];
        let bytes = 0;
        for (const part of parts) {
          for await (const [key, value] of view.iterate(part)) {
            chunk.push({ $typeName: 'mindlog.v1.KeyValue', key, value });
            bytes += key.length + value.length;
            if (bytes >= chunkBytes) {
              yield chunk;
              chunk = [];
              bytes = 0;
            }
          }
        }
        if (chunk.length > 0) yield chunk;
      },
      release: () => view.release(),
    };
  }

  /**
   * Replaces the range's keys and state with a snapshot's in one atomic
   * synced batch (ADR-0026). Keys of other ranges in the store are kept. The
   * pairs carry the applied point, membership and descriptor, which must
   * match `meta`; a mismatch is corruption and throws.
   */
  async installSnapshot(meta: SnapshotMeta, pairs: readonly KeyValue[]): Promise<void> {
    const store = this.#deps.store;
    const descKey = rangeDescriptorKey(this.#rangeId);
    const incoming = pairs.find((p) => Buffer.compare(p.key, descKey) === 0);
    if (!incoming) throw new Error(`snapshot of range ${this.#rangeId} has no descriptor`);
    const next = fromBinary(RangeDescriptorSchema, incoming.value);
    const batch = store.batch();
    for (const part of [...this.#ownKeys(this.#installedSpan()), ...this.#ownKeys(next)])
      for await (const [key] of store.iterate(part)) batch.del(key);
    for (const { key, value } of pairs) batch.put(key, value);
    await batch.write({ sync: true });
    const state = await readRangeState(store, this.#rangeId);
    if (state.applied.index !== meta.index || state.applied.term !== meta.term)
      throw new Error(
        `snapshot data is at ${state.applied.index}/${state.applied.term}, not ${meta.index}/${meta.term}`,
      );
    this.#applied = state.applied;
    this.#confState = state.confState;
    this.#descriptor = next;
    this.#lastVersion = state.lastVersion;
  }

  /** The span whose data this replica holds: none before its first apply or install. */
  #installedSpan(): RangeDescriptor {
    return this.#applied.index > 0n
      ? this.#descriptor
      : create(RangeDescriptorSchema, { rangeId: this.#rangeId, endKey: new Uint8Array([0]) });
  }

  #ownKeys(descriptor: RangeDescriptor) {
    return [...spanIntervals(descriptor), prefixRange(rangeLocalPrefix(this.#rangeId))];
  }

  #checkOrder(index: bigint): void {
    if (index !== this.#applied.index + 1n) {
      throw new Error(`apply out of order: got ${index}, expected ${this.#applied.index + 1n}`);
    }
  }

  async #commit(batch: WriteBatch, applied: AppliedPoint): Promise<void> {
    batch.put(appliedIndexKey(this.#rangeId), encodeApplied(applied));
    await batch.write();
    this.#applied = applied;
  }

  async #execute(
    index: bigint,
    version: bigint,
    command: Command,
    batch: WriteBatch,
  ): Promise<CommandResult> {
    const body = command.body.case;
    if (body === undefined) return errorResult('INVALID_ARGUMENT', 'command has no body');
    const handler = this.#deps.handlers.get(body);
    if (!handler) return errorResult('UNIMPLEMENTED', `no apply handler for '${body}'`);
    const txn = new MvccTxn(new SpanReader(this.#deps.store, this.#descriptor), version);
    const result = await handler.apply({
      index,
      version,
      descriptor: this.#descriptor,
      command,
      txn,
      nowMs: hlcPhysical(command.hlc as Hlc),
      random: new SeededRandom(index),
      raw: { reader: this.#deps.store, batch },
    });
    txn.writeTo(batch);
    return result;
  }
}

async function readRangeState(reader: KvReader, rangeId: bigint): Promise<RangeState> {
  const [applied, conf, descriptor, lastVersion] = await Promise.all([
    reader.get(appliedIndexKey(rangeId)),
    reader.get(confStateKey(rangeId)),
    reader.get(rangeDescriptorKey(rangeId)),
    reader.get(lastVersionKey(rangeId)),
  ]);
  return {
    applied: applied ? decodeApplied(applied) : { index: 0n, term: 0n },
    confState: conf ? fromBinary(ConfStateSchema, conf) : create(ConfStateSchema, {}),
    descriptor: descriptor ? fromBinary(RangeDescriptorSchema, descriptor) : undefined,
    lastVersion: lastVersion ? decodeU64(lastVersion) : 0n,
  };
}
