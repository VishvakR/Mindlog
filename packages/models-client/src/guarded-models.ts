import type { Clock, MindlogError, Metrics, Result } from '@mindlog/core';
import { err, mindlogError } from '@mindlog/core';
import type { EventBus } from '@mindlog/eventbus';
import type {
  CallOptions,
  Capability,
  EmbedKind,
  Embeddings,
  ExtractedFacts,
  Models,
  ModelServiceStatus,
  NliResults,
  RecognizedEntities,
  RerankScores,
  SummarizeOptions,
  Summary,
} from './ports.js';

export interface GuardedModelsOptions {
  readonly clock: Clock;
  readonly metrics: Metrics;
  /** Receives `ModelServiceHealth` when the first breaker opens and when all close again. */
  readonly bus?: EventBus;
  /** Consecutive failures that open a breaker (default 5). */
  readonly failures?: number;
  /** How long an open breaker fails fast before one probe (default 10 s). */
  readonly openMs?: number;
}

/** Failures that say the service is unwell; `BUSY` is backpressure and only sheds the call. */
const FAILURES = new Set(['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL']);

interface Breaker {
  failures: number;
  /** Clock time it opened; undefined while closed. */
  openedAt: bigint | undefined;
  probing: boolean;
}

/**
 * Deadlines, a circuit breaker per capability and metrics around a `Models`
 * (PLAN 21, CLAUDE.md §6). An open breaker fails fast with `UNAVAILABLE`, so
 * the memory pipeline degrades instead of waiting on a hung service; after
 * `openMs` one call probes, and its success closes the breaker.
 */
export class GuardedModels implements Models {
  readonly #inner: Models;
  readonly #o: Required<Omit<GuardedModelsOptions, 'bus'>> & { bus?: EventBus };
  readonly #breakers = new Map<Capability, Breaker>();
  #anyOpen = false;

  constructor(inner: Models, options: GuardedModelsOptions) {
    this.#inner = inner;
    this.#o = { failures: 5, openMs: 10_000, ...options };
  }

  /** Whether any capability's breaker is open. */
  get open(): boolean {
    return [...this.#breakers.values()].some((b) => b.openedAt !== undefined);
  }

  /** Whether calls for `capability` currently reach the service. */
  available(capability: Capability): boolean {
    const b = this.#breakers.get(capability);
    return b?.openedAt === undefined || this.#o.clock.now() >= b.openedAt + BigInt(this.#o.openMs);
  }

  async #guard<T>(
    capability: Capability,
    method: string,
    run: () => Promise<Result<T, MindlogError>>,
  ): Promise<Result<T, MindlogError>> {
    let b = this.#breakers.get(capability);
    if (!b) {
      b = { failures: 0, openedAt: undefined, probing: false };
      this.#breakers.set(capability, b);
    }
    if (b.openedAt !== undefined) {
      if (b.probing || this.#o.clock.now() < b.openedAt + BigInt(this.#o.openMs))
        return err(mindlogError('UNAVAILABLE', `model service circuit open for ${capability}`));
      b.probing = true;
    }
    const started = this.#o.clock.monotonic();
    const result = await run();
    b.probing = false;
    const seconds = Number(this.#o.clock.monotonic() - started) / 1e9;
    this.#o.metrics
      .histogram({
        name: 'mindlog_models_call_latency_seconds',
        help: 'Model service call latency',
        labelNames: ['method'],
      })
      .observe(seconds, { method });
    if (result.ok) {
      b.failures = 0;
      b.openedAt = undefined;
    } else {
      this.#o.metrics
        .counter({
          name: 'mindlog_models_errors_total',
          help: 'Failed model service calls',
          labelNames: ['method', 'code'],
        })
        .inc(1, { method, code: result.error.code });
      if (FAILURES.has(result.error.code)) {
        b.failures++;
        if (b.openedAt !== undefined || b.failures >= this.#o.failures)
          b.openedAt = this.#o.clock.now();
      }
    }
    this.#publish();
    return result;
  }

  #publish(): void {
    const open = this.open;
    if (open === this.#anyOpen) return;
    this.#anyOpen = open;
    this.#o.bus?.publish({ type: 'ModelServiceHealth', up: !open });
  }

  embed(
    texts: readonly string[],
    kind: EmbedKind,
    options?: CallOptions,
  ): Promise<Result<Embeddings, MindlogError>> {
    return this.#guard('embed', 'embed', () => this.#inner.embed(texts, kind, options));
  }

  recognize(
    texts: readonly string[],
    labels: readonly string[],
    options?: CallOptions,
  ): Promise<Result<RecognizedEntities, MindlogError>> {
    return this.#guard('ner', 'recognize', () => this.#inner.recognize(texts, labels, options));
  }

  classify(
    pairs: ReadonlyArray<readonly [string, string]>,
    options?: CallOptions,
  ): Promise<Result<NliResults, MindlogError>> {
    return this.#guard('nli', 'classify', () => this.#inner.classify(pairs, options));
  }

  rerank(
    query: string,
    documents: readonly string[],
    options?: CallOptions,
  ): Promise<Result<RerankScores, MindlogError>> {
    return this.#guard('rerank', 'rerank', () => this.#inner.rerank(query, documents, options));
  }

  extractFacts(text: string, options?: CallOptions): Promise<Result<ExtractedFacts, MindlogError>> {
    return this.#guard('extract', 'extractFacts', () => this.#inner.extractFacts(text, options));
  }

  summarize(
    texts: readonly string[],
    instruction: string,
    options?: SummarizeOptions,
  ): Promise<Result<Summary, MindlogError>> {
    return this.#guard('summarize', 'summarize', () =>
      this.#inner.summarize(texts, instruction, options),
    );
  }

  health(options?: CallOptions): Promise<Result<ModelServiceStatus, MindlogError>> {
    return this.#inner.health(options);
  }
}
