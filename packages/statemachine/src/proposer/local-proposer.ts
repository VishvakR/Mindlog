import type { Gauge, Histogram, Logger, MindlogError, Metrics, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { Command } from '@mindlog/proto';
import type { StateMachine } from '../apply/state-machine.js';
import type { LocalLog } from '../log/local-log.js';
import type { Proposal, Proposer } from './proposer.js';

export interface LocalProposerOptions {
  /** Proposals waiting beyond this are rejected with BUSY. */
  readonly maxQueue?: number;
  /** Most commands written by one log append (one fsync). */
  readonly maxBatch?: number;
  /** Flush state and compact the log after this many applied commands. */
  readonly checkpointEvery?: number;
}

export interface LocalProposerDeps {
  readonly log: LocalLog;
  readonly machine: StateMachine;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly options?: LocalProposerOptions;
}

interface Waiting {
  readonly command: Command;
  readonly resolve: (result: Result<Proposal, MindlogError>) => void;
}

/**
 * Single-node Proposer (phase 1). Proposals made in the same event-loop turn
 * are group-committed: one log append with one fsync, then each is applied in
 * order and resolved. Results are only returned after both, so an
 * acknowledged write survives kill -9. A storage failure stops the proposer
 * for good (fail-stop); everything pending gets UNAVAILABLE.
 */
export class LocalProposer implements Proposer {
  readonly #deps: LocalProposerDeps;
  readonly #maxQueue: number;
  readonly #maxBatch: number;
  readonly #checkpointEvery: bigint;
  #checkpointed: bigint;
  readonly #queue: Waiting[] = [];
  readonly #depth: Gauge;
  readonly #groupSize: Histogram;
  #draining: Promise<void> | undefined;
  #failure: unknown;
  #closed = false;

  constructor(deps: LocalProposerDeps) {
    this.#deps = deps;
    this.#maxQueue = deps.options?.maxQueue ?? 10_000;
    this.#maxBatch = deps.options?.maxBatch ?? 512;
    this.#checkpointEvery = BigInt(deps.options?.checkpointEvery ?? 10_000);
    this.#checkpointed = deps.machine.appliedIndex;
    this.#depth = deps.metrics.gauge({
      name: 'mindlog_statemachine_proposal_queue_count',
      help: 'Proposals waiting for the next group commit',
    });
    this.#groupSize = deps.metrics.histogram({
      name: 'mindlog_statemachine_group_commit_entries',
      help: 'Commands written per log append (one fsync)',
      buckets: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
    });
  }

  /** The error that stopped the proposer, if any. */
  get failure(): unknown {
    return this.#failure;
  }

  propose(command: Command): Promise<Result<Proposal, MindlogError>> {
    if (this.#failure !== undefined || this.#closed) {
      return Promise.resolve(err(mindlogError('UNAVAILABLE', 'the proposer has stopped')));
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.resolve(
        err(mindlogError('BUSY', 'too many pending writes', { retryAfterMs: 10 })),
      );
    }
    return new Promise((resolve) => {
      this.#queue.push({ command, resolve });
      this.#depth.set(this.#queue.length);
      this.#draining ??= new Promise((done) => setImmediate(done)).then(() => this.#drain());
    });
  }

  /** Flushes applied state, then compacts the log up to the flushed index. */
  async checkpoint(): Promise<void> {
    const durable = await this.#deps.machine.flush();
    await this.#deps.log.compact(durable);
    this.#checkpointed = durable;
  }

  /** Stops accepting proposals and waits for pending ones to finish. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#draining;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0 && this.#failure === undefined) {
        const group = this.#queue.splice(0, this.#maxBatch);
        this.#depth.set(this.#queue.length);
        await this.#commit(group);
      }
    } finally {
      this.#draining = undefined;
      if (this.#queue.length > 0 && this.#failure === undefined) {
        this.#draining = this.#drain();
      }
    }
  }

  async #commit(group: Waiting[]): Promise<void> {
    try {
      const indexes = await this.#deps.log.append(group.map((w) => w.command));
      this.#groupSize.observe(group.length);
      for (const [i, waiting] of group.entries()) {
        const index = indexes[i] ?? 0n;
        const result = await this.#deps.machine.apply(index, waiting.command);
        waiting.resolve(ok({ index, result }));
      }
      if (this.#deps.machine.appliedIndex - this.#checkpointed >= this.#checkpointEvery) {
        await this.checkpoint();
      }
    } catch (cause: unknown) {
      this.#failure = cause;
      this.#deps.logger.fatal('proposer stopped after a storage or apply failure', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      const stopped = err(mindlogError('UNAVAILABLE', 'the replica stopped after a failure'));
      for (const waiting of [...group, ...this.#queue.splice(0)]) waiting.resolve(stopped);
    }
  }
}
