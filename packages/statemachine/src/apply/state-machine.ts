import type { Clock, Counter, Hlc, Histogram, Logger, Metrics } from '@mindlog/core';
import { SeededRandom, hlcPhysical } from '@mindlog/core';
import type { EventBus } from '@mindlog/eventbus';
import type { Command, CommandResult } from '@mindlog/proto';
import type { KvStore } from '@mindlog/storage';
import { MvccTxn } from '@mindlog/storage';
import { IdempotencyTable } from '../system/idempotency-table.js';
import { appliedIndexKey } from '../system/system-keys.js';
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

const encodeIndex = (index: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, index);
  return out;
};

const decodeIndex = (bytes: Uint8Array): bigint =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0);

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
  readonly #applied: Counter;
  #appliedIndex: bigint;

  private constructor(deps: StateMachineDeps, appliedIndex: bigint) {
    this.#deps = deps;
    this.#rangeId = deps.rangeId ?? 1n;
    this.#idempotency = new IdempotencyTable(deps.store);
    this.#appliedIndex = appliedIndex;
    this.#latency = deps.metrics.histogram({
      name: 'mindlog_statemachine_apply_latency_seconds',
      help: 'Time to apply one committed command',
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
    });
    this.#applied = deps.metrics.counter({
      name: 'mindlog_statemachine_applied_total',
      help: 'Commands applied, by body kind',
      labelNames: ['body'],
    });
  }

  static async open(deps: StateMachineDeps): Promise<StateMachine> {
    const stored = await deps.store.get(appliedIndexKey(deps.rangeId ?? 1n));
    return new StateMachine(deps, stored ? decodeIndex(stored) : 0n);
  }

  get appliedIndex(): bigint {
    return this.#appliedIndex;
  }

  async apply(index: bigint, command: Command): Promise<CommandResult> {
    if (index !== this.#appliedIndex + 1n) {
      throw new Error(`apply out of order: got ${index}, expected ${this.#appliedIndex + 1n}`);
    }
    const started = this.#deps.clock.monotonic();
    const batch = this.#deps.store.batch();
    let result = await this.#idempotency.lookup(command.requestId);
    if (!result) {
      result = await this.#execute(index, command, batch);
      this.#idempotency.record(batch, command.requestId, result);
    }
    batch.put(appliedIndexKey(this.#rangeId), encodeIndex(index));
    await batch.write();
    this.#appliedIndex = index;

    const body = command.body.case ?? 'none';
    this.#applied.inc(1, { body });
    this.#latency.observe(Number(this.#deps.clock.monotonic() - started) / 1e9);
    this.#deps.events.publish({ type: 'CommandApplied', rangeId: this.#rangeId, index, command });
    return result;
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
    });
    txn.writeTo(batch);
    return result;
  }
}
