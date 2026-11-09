import type { Clock, Counter, Hlc, Histogram, Logger, Metrics } from '@mindlog/core';
import { SeededRandom, decodeKey, hlcPhysical, prefixRange } from '@mindlog/core';
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
import { auditRecordOf, writeAuditOutbox } from '../audit/audit.js';
import { IdempotencyTable } from '../system/idempotency-table.js';
import {
  appliedIndexKey,
  confStateKey,
  lastVersionKey,
  rangeDescriptorKey,
  rangeLocalPrefix,
  removedKey,
  replicaIdKey,
} from '../system/system-keys.js';
import {
  RANGE_INIT_INDEX,
  SpanReader,
  isUninitialised,
  spanIntervals,
  uninitialised,
  wholeKeyspace,
} from '../range/span.js';
import type { RangeHooks } from '../range/range-commands.js';
import type { SplitPoint } from '../range/split-key.js';
import { findSplitKey } from '../range/split-key.js';
import {
  applyFreeze,
  applyMerge,
  applySplit,
  decodeU64,
  encodeU64,
  frozenKey,
  statsKey,
} from '../range/range-commands.js';
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
  /** Descriptor when the store has none; without one the replica is uninitialised (ADR-0028). */
  readonly descriptor?: RangeDescriptor;
  /** Range-local state of other packages, moved on split and merge (ADR-0009). */
  readonly rangeHooks?: readonly RangeHooks[];
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

interface RangeState {
  readonly applied: AppliedPoint;
  readonly confState: ConfState;
  readonly descriptor: RangeDescriptor | undefined;
  readonly lastVersion: bigint;
  readonly frozenFor: bigint;
  readonly bytes: bigint;
  readonly replicaId: bigint | undefined;
  readonly removed: ReadonlySet<bigint>;
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
  #frozenFor: bigint;
  #bytes: bigint;
  #replicaId: bigint | undefined;
  #removed: ReadonlySet<bigint>;
  #appliedHlc = 0n;

  private constructor(deps: StateMachineDeps, rangeId: bigint, state: RangeState) {
    this.#deps = deps;
    this.#rangeId = rangeId;
    this.#idempotency = new IdempotencyTable(deps.store, rangeId);
    this.#applied = state.applied;
    this.#confState = state.confState;
    this.#descriptor = state.descriptor ?? deps.descriptor ?? uninitialised(rangeId);
    this.#lastVersion = state.lastVersion;
    this.#frozenFor = state.frozenFor;
    this.#bytes = state.bytes;
    this.#replicaId = state.replicaId;
    this.#removed = state.removed;
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
    if (!state.descriptor && deps.descriptor) {
      const batch = deps.store.batch();
      batch.put(rangeDescriptorKey(rangeId), toBinary(RangeDescriptorSchema, deps.descriptor));
      await batch.write();
    }
    return new StateMachine(deps, rangeId, state);
  }

  /**
   * Writes the initial state of a brand-new range on one of its first nodes:
   * applied at `RANGE_INIT_INDEX`, the initial members and the descriptor
   * (the whole keyspace unless the deps gave one). Replicas created any other
   * way start empty and get all of this from a snapshot (ADR-0028).
   */
  async bootstrap(confState: ConfState): Promise<AppliedPoint> {
    if (this.#applied.index !== 0n) throw new Error('only a brand-new range can be bootstrapped');
    const descriptor = isUninitialised(this.#descriptor)
      ? wholeKeyspace(this.#rangeId)
      : this.#descriptor;
    const applied = { index: RANGE_INIT_INDEX, term: RANGE_INIT_INDEX };
    const batch = this.#deps.store.batch();
    batch.put(confStateKey(this.#rangeId), toBinary(ConfStateSchema, confState));
    batch.put(rangeDescriptorKey(this.#rangeId), toBinary(RangeDescriptorSchema, descriptor));
    batch.put(appliedIndexKey(this.#rangeId), encodeApplied(applied));
    await batch.write({ sync: true });
    this.#applied = applied;
    this.#confState = confState;
    this.#descriptor = descriptor;
    return applied;
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

  /** The Raft id this replica was created with, once recorded (ADR-0028). */
  get replicaId(): bigint | undefined {
    return this.#replicaId;
  }

  /** True if `id` was removed from this range's membership (ADR-0028). */
  isRemoved(id: bigint): boolean {
    return this.#removed.has(id);
  }

  /** Records the replica's Raft id before it takes part in the range; ignored once set. */
  async rememberReplicaId(id: bigint): Promise<void> {
    if (this.#replicaId !== undefined) return;
    const batch = this.#deps.store.batch();
    batch.put(replicaIdKey(this.#rangeId), encodeU64(id));
    await batch.write({ sync: true });
    this.#replicaId = id;
  }

  /** The range this one is frozen for (a merge in progress), or 0 (ADR-0009). */
  get frozenFor(): bigint {
    return this.#frozenFor;
  }

  /** Approximate bytes in the range, for split and merge decisions (ADR-0009). */
  get approximateBytes(): bigint {
    return this.#bytes;
  }

  /** Deletes the range's own state (its replica is being removed); user keys are left to the new owner. */
  async destroyState(): Promise<void> {
    const batch = this.#deps.store.batch();
    for await (const [key] of this.#deps.store.iterate(
      prefixRange(rangeLocalPrefix(this.#rangeId)),
    ))
      batch.del(key);
    await batch.write({ sync: true });
  }

  /** Where the leader would split this range now (ADR-0009); reads applied state. */
  findSplitKey(): Promise<SplitPoint | undefined> {
    return findSplitKey(this.#deps.store, this.#descriptor);
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
    const duplicate = result !== undefined;
    const frozen = result ? undefined : this.#frozenResult(command);
    if (frozen) {
      // The refusal is recorded, so a re-proposed copy of the same request gets the same answer
      // after an unfreeze instead of being applied. It takes no version and is kept apart from the
      // idempotency records a merge folds in, so the merged state does not depend on how many
      // refused commands a replica has seen (ADR-0009; SIM_MEM seed 197).
      this.#idempotency.recordRefusal(batch, command.requestId, frozen);
      await this.#commit(batch, { index, term });
      return frozen;
    }
    if (!result) {
      // A freeze takes no version: whether a replica applied a repeated freeze before it stops
      // for a merge must not change what the merge folds in (ADR-0009).
      const version =
        command.body.case === 'freeze'
          ? this.#lastVersion
          : command.hlc > this.#lastVersion
            ? command.hlc
            : this.#lastVersion + 1n;
      this.#lastVersion = version;
      result = await this.#execute(index, version, command, batch);
      this.#idempotency.record(batch, command.requestId, result, version);
      batch.put(lastVersionKey(this.#rangeId), encodeU64(this.#lastVersion));
      batch.put(statsKey(this.#rangeId), encodeU64(this.#bytes));
    }
    await this.#commit(batch, { index, term });
    if (command.hlc > this.#appliedHlc) this.#appliedHlc = command.hlc;

    const body = command.body.case ?? 'none';
    this.#appliedTotal.inc(1, { body });
    this.#latency.observe(Number(this.#deps.clock.monotonic() - started) / 1e9);
    this.#deps.events.publish({
      type: 'CommandApplied',
      rangeId: this.#rangeId,
      index,
      command,
      result,
      duplicate,
    });
    return result;
  }

  /** Applies an entry with no command (the leader's no-op). */
  async applyEmpty(index: bigint, term: bigint): Promise<void> {
    this.#checkOrder(index);
    await this.#commit(this.#deps.store.batch(), { index, term });
  }

  /** Records the membership that a configuration entry produced (ADR-0006). */
  async applyConfState(
    index: bigint,
    term: bigint,
    confState: ConfState,
    removed?: bigint,
  ): Promise<void> {
    this.#checkOrder(index);
    const batch = this.#deps.store.batch();
    if (removed !== undefined) batch.put(removedKey(this.#rangeId, removed), new Uint8Array());
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
    if (removed !== undefined) this.#removed = new Set([...this.#removed, removed]);
  }

  /**
   * A consistent view of the range: its keys and its range-local `$node`
   * state (ADR-0028), labelled with its applied point.
   */
  async snapshot(): Promise<StateSnapshot> {
    const view = await this.#deps.store.snapshot();
    const state = await readRangeState(view, this.#rangeId);
    const parts = this.#ownKeys(state.descriptor ?? this.#descriptor);
    const mine = replicaIdKey(this.#rangeId);
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
            // The Raft id belongs to the replica, not to the range's state.
            if (Buffer.compare(key, mine) === 0) continue;
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
    const mine = replicaIdKey(this.#rangeId);
    // Only the span being installed is replaced: if the range shrank (a split this replica missed),
    // the rest belongs to the new range, whose replica on this node keeps its own data.
    for (const part of this.#ownKeys(next))
      for await (const [key] of store.iterate(part))
        if (Buffer.compare(key, mine) !== 0) batch.del(key);
    for (const { key, value } of pairs) if (Buffer.compare(key, mine) !== 0) batch.put(key, value);
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
    this.#frozenFor = state.frozenFor;
    this.#bytes = state.bytes;
    this.#removed = state.removed;
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
    if (body === 'split' || body === 'freeze' || body === 'merge')
      return this.#rangeCommand(version, command, batch);
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
    this.#bytes += txn.bytes;
    const audit = auditRecordOf(
      command,
      result,
      this.#rangeId,
      index,
      hlcPhysical(command.hlc as Hlc),
    );
    if (audit) writeAuditOutbox(batch, this.#rangeId, version, audit);
    return result;
  }

  /** A frozen range applies only its unfreeze (ADR-0009); the rest is refused without a trace. */
  #frozenResult(command: Command): CommandResult | undefined {
    if (this.#frozenFor === 0n) return undefined;
    // Freezes (even repeated ones) run and are recorded, so a re-proposed copy of one cannot
    // freeze the range again after its unfreeze.
    const body = command.body;
    if (body.case === 'freeze') {
      const to = body.value.mergeInto;
      return to === 0n || to === this.#frozenFor
        ? undefined
        : errorResult(
            'CONFLICT',
            `range ${this.#rangeId} is already merging into ${this.#frozenFor}`,
          );
    }
    return errorResult('RANGE_MOVED', `range ${this.#rangeId} is merging into ${this.#frozenFor}`);
  }

  /** Split, freeze and merge change the range itself (ADR-0009). */
  async #rangeCommand(
    version: bigint,
    command: Command,
    batch: WriteBatch,
  ): Promise<CommandResult> {
    const ctx = {
      reader: this.#deps.store,
      batch,
      descriptor: this.#descriptor,
      confState: this.#confState,
      version,
      bytes: this.#bytes,
      hooks: this.#deps.rangeHooks ?? [],
    };
    const body = command.body;
    const change =
      body.case === 'split'
        ? await applySplit(ctx, body.value)
        : body.case === 'merge'
          ? await applyMerge(ctx, body.value)
          : body.case === 'freeze'
            ? applyFreeze(ctx, body.value)
            : undefined;
    if (!change) return errorResult('INTERNAL', 'not a range command');
    if (change.descriptor) this.#descriptor = change.descriptor;
    if (change.bytes !== undefined) this.#bytes = change.bytes;
    if (change.frozenFor !== undefined) this.#frozenFor = change.frozenFor;
    if (change.lastVersion !== undefined) this.#lastVersion = change.lastVersion;
    return change.result;
  }
}

async function readRangeState(reader: KvReader, rangeId: bigint): Promise<RangeState> {
  const [applied, conf, descriptor, lastVersion, frozen, stats, replicaId] = await Promise.all([
    reader.get(appliedIndexKey(rangeId)),
    reader.get(confStateKey(rangeId)),
    reader.get(rangeDescriptorKey(rangeId)),
    reader.get(lastVersionKey(rangeId)),
    reader.get(frozenKey(rangeId)),
    reader.get(statsKey(rangeId)),
    reader.get(replicaIdKey(rangeId)),
  ]);
  return {
    applied: applied ? decodeApplied(applied) : { index: 0n, term: 0n },
    confState: conf ? fromBinary(ConfStateSchema, conf) : create(ConfStateSchema, {}),
    descriptor: descriptor ? fromBinary(RangeDescriptorSchema, descriptor) : undefined,
    lastVersion: lastVersion ? decodeU64(lastVersion) : 0n,
    frozenFor: frozen ? decodeU64(frozen) : 0n,
    bytes: stats ? decodeU64(stats) : 0n,
    replicaId: replicaId ? decodeU64(replicaId) : undefined,
    removed: await readRemoved(reader, rangeId),
  };
}

async function readRemoved(reader: KvReader, rangeId: bigint): Promise<ReadonlySet<bigint>> {
  const out = new Set<bigint>();
  for await (const [key] of reader.iterate(prefixRange(rangeLocalPrefix(rangeId, 'removed')))) {
    const decoded = decodeKey(key);
    const id = decoded.ok ? decoded.value.tuple[3] : undefined;
    if (typeof id === 'bigint') out.add(id);
  }
  return out;
}
