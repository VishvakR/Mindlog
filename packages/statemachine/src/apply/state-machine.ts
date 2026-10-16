import type { Clock, Counter, Hlc, Histogram, Logger, Metrics } from '@mindlog/core';
import { SeededRandom, hlcPhysical } from '@mindlog/core';
import type { EventBus } from '@mindlog/eventbus';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { Command, CommandResult, ConfState, KeyValue, SnapshotMeta } from '@mindlog/proto';
import { ConfStateSchema, SnapshotMetaSchema } from '@mindlog/proto';
import type { KvStore, WriteBatch } from '@mindlog/storage';
import { MvccTxn } from '@mindlog/storage';
import { IdempotencyTable } from '../system/idempotency-table.js';
import { WHOLE_STORE, appliedIndexKey, confStateKey } from '../system/system-keys.js';
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

/**
 * Applies committed commands in log order (PLAN 6.2). Each apply is one write
 * batch holding the handler's MVCC changes, the idempotency record and the new
 * applied index, so state and applied index never disagree. Handlers see only
 * deterministic inputs; a thrown error stops the replica (fail-stop).
 */
export class StateMachine {
  readonly #deps: StateMachineDeps;
  readonly #rangeId: bigint;
  readonly #idempotency: IdempotencyTable;
  readonly #latency: Histogram;
  readonly #appliedTotal: Counter;
  #applied: AppliedPoint;
  #confState: ConfState;
  #appliedHlc = 0n;

  private constructor(deps: StateMachineDeps, applied: AppliedPoint, confState: ConfState) {
    this.#deps = deps;
    this.#rangeId = deps.rangeId ?? 1n;
    this.#idempotency = new IdempotencyTable(deps.store);
    this.#applied = applied;
    this.#confState = confState;
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
    const [applied, confState] = await readAppliedState(deps.store, deps.rangeId ?? 1n);
    return new StateMachine(deps, applied, confState);
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
      result = await this.#execute(index, command, batch);
      this.#idempotency.record(batch, command.requestId, result, index);
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
    await this.#commit(batch, { index, term });
    this.#confState = confState;
  }

  /** A consistent view of the whole state store, labelled with its applied point. */
  async snapshot(): Promise<StateSnapshot> {
    const view = await this.#deps.store.snapshot();
    const [applied, confState] = await readAppliedState(view, this.#rangeId);
    return {
      meta: create(SnapshotMetaSchema, { index: applied.index, term: applied.term, confState }),
      async *chunks(chunkBytes: number) {
        let chunk: KeyValue[] = [];
        let bytes = 0;
        for await (const [key, value] of view.iterate(WHOLE_STORE)) {
          chunk.push({ $typeName: 'mindlog.v1.KeyValue', key, value });
          bytes += key.length + value.length;
          if (bytes >= chunkBytes) {
            yield chunk;
            chunk = [];
            bytes = 0;
          }
        }
        if (chunk.length > 0) yield chunk;
      },
      release: () => view.release(),
    };
  }

  /**
   * Replaces the whole state with a snapshot's contents in one atomic synced
   * batch (ADR-0026). The pairs carry the applied point and membership, which
   * must match `meta`; a mismatch is corruption and throws.
   */
  async installSnapshot(meta: SnapshotMeta, pairs: readonly KeyValue[]): Promise<void> {
    const store = this.#deps.store;
    const batch = store.batch();
    for await (const [key] of store.iterate(WHOLE_STORE)) batch.del(key);
    for (const { key, value } of pairs) batch.put(key, value);
    await batch.write({ sync: true });
    const [applied, confState] = await readAppliedState(store, this.#rangeId);
    if (applied.index !== meta.index || applied.term !== meta.term)
      throw new Error(
        `snapshot data is at ${applied.index}/${applied.term}, not ${meta.index}/${meta.term}`,
      );
    this.#applied = applied;
    this.#confState = confState;
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
    command: Command,
    batch: ReturnType<KvStore['batch']>,
  ): Promise<CommandResult> {
    const body = command.body.case;
    if (body === undefined) return errorResult('INVALID_ARGUMENT', 'command has no body');
    const handler = this.#deps.handlers.get(body);
    if (!handler) return errorResult('UNIMPLEMENTED', `no apply handler for '${body}'`);
    const txn = new MvccTxn(this.#deps.store, index);
    const result = await handler.apply({
      index,
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

async function readAppliedState(
  reader: Pick<KvStore, 'get'>,
  rangeId: bigint,
): Promise<[AppliedPoint, ConfState]> {
  const applied = await reader.get(appliedIndexKey(rangeId));
  const conf = await reader.get(confStateKey(rangeId));
  return [
    applied ? decodeApplied(applied) : { index: 0n, term: 0n },
    conf ? fromBinary(ConfStateSchema, conf) : create(ConfStateSchema, {}),
  ];
}
