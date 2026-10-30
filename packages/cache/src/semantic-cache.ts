import { create, fromBinary } from '@bufbuild/protobuf';
import type { Clock, Metrics, MindlogError, MindlogErrorCode, Result, Tracer } from '@mindlog/core';
import { ERROR_CODES, err, mindlogError, ok } from '@mindlog/core';
import type { Embedder } from '@mindlog/models-client';
import type { CacheEntry, Command, CommandResult } from '@mindlog/proto';
import { CacheEntrySchema } from '@mindlog/proto';
import type { CommandStamper, Proposer } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import { entryKey, entryPrefix } from './keys.js';
import { encodeVector, normalizePrompt } from './prompt.js';
import type { CacheQuery, SimilarityEvaluator } from './similarity.js';
import { cosineEvaluator, similarityOf } from './similarity.js';

const CODES = new Set(Object.keys(ERROR_CODES));
const known = (code: string): MindlogErrorCode =>
  CODES.has(code) ? (code as MindlogErrorCode) : 'INTERNAL';

/** The range holding a user scope: propose to it, read its applied state. */
export interface CacheRange {
  readonly proposer: Proposer;
  readonly reader: KvReader;
}

export interface CacheScope {
  readonly tenant: string;
  readonly user: string;
}

export interface CacheCall {
  readonly principal: string;
  readonly requestId?: Uint8Array;
}

export interface CacheHit {
  readonly id: string;
  readonly answer: string;
  readonly similarity: number;
  /** `l1`: this node's exact-prompt map; `l2`: the replicated entries. */
  readonly level: 'l1' | 'l2';
  readonly dependsOn: readonly string[];
  readonly modelHint?: string;
}

export interface CacheLookup {
  readonly hit?: CacheHit;
  /** True when no embedding could be made, so only exact prompts can match. */
  readonly degraded: boolean;
}

export interface CacheStoreInput {
  readonly prompt: string;
  readonly answer: string;
  /** Memory ids the answer was derived from; forgetting one drops the entry (ADR-0012). */
  readonly dependsOn?: readonly string[];
  readonly ttlSeconds?: number;
  readonly modelHint?: string;
}

export interface SemanticCacheConfig {
  /** Default similarity a hit needs (PLAN 13.9: 0.92). */
  readonly threshold: number;
  /** Entries per user scope; the oldest are evicted (ADR-0012). */
  readonly maxEntries: number;
  /** Prompts in this node's L1 map. */
  readonly l1Entries: number;
  readonly modelTimeoutMs: number;
}

export const DEFAULT_CACHE_CONFIG: SemanticCacheConfig = {
  threshold: 0.92,
  maxEntries: 1000,
  l1Entries: 10_000,
  modelTimeoutMs: 2000,
};

export interface SemanticCacheDeps {
  readonly models: Embedder;
  readonly stamper: CommandStamper;
  readonly ids: { next(): string };
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
  readonly evaluator?: SimilarityEvaluator;
  readonly config?: Partial<SemanticCacheConfig>;
}

/**
 * The memory-aware semantic cache (PLAN 13.9, ADR-0012) on one range: stores
 * answers with the memories they depend on and finds them again for similar
 * prompts. L1 maps exact normalised prompts to entry ids on this node; L2
 * scans the scope's replicated entries by cosine and lets the evaluator
 * confirm the best one.
 */
export class SemanticCache {
  readonly #d: SemanticCacheDeps;
  readonly #config: SemanticCacheConfig;
  readonly #evaluator: SimilarityEvaluator;
  readonly #l1 = new Map<string, string>();

  constructor(deps: SemanticCacheDeps) {
    this.#d = deps;
    this.#config = { ...DEFAULT_CACHE_CONFIG, ...deps.config };
    this.#evaluator = deps.evaluator ?? cosineEvaluator;
  }

  get config(): SemanticCacheConfig {
    return this.#config;
  }

  #l1Key = (scope: CacheScope, prompt: string) =>
    `${scope.tenant}\u0000${scope.user}\u0000${prompt}`;

  #remember(key: string, id: string): void {
    this.#l1.delete(key);
    this.#l1.set(key, id);
    while (this.#l1.size > this.#config.l1Entries) {
      const oldest = this.#l1.keys().next().value;
      if (oldest === undefined) break;
      this.#l1.delete(oldest);
    }
  }

  async #embed(prompt: string): Promise<{ vector?: Float32Array; modelId?: string }> {
    const r = await this.#d.models.embed([prompt], 'query', {
      timeoutMs: this.#config.modelTimeoutMs,
    });
    const vector = r.ok ? r.value.vectors[0] : undefined;
    return vector && r.ok ? { vector, modelId: r.value.modelId } : {};
  }

  #live = (entry: CacheEntry): boolean =>
    entry.expiresAtMs === 0n || entry.expiresAtMs > this.#d.clock.now();

  #count(result: 'hit_l1' | 'hit_l2' | 'miss', hit?: CacheHit): void {
    this.#d.metrics
      .counter({
        name: 'mindlog_cache_lookups_total',
        help: 'Semantic cache lookups by result',
        labelNames: ['result'],
      })
      .inc(1, { result });
    if (hit)
      this.#d.metrics
        .counter({
          name: 'mindlog_cache_tokens_saved_total',
          help: 'Estimated answer tokens served from the cache (~4 characters each)',
        })
        .inc(Math.ceil(hit.answer.length / 4));
  }

  static #hit(entry: CacheEntry, similarity: number, level: 'l1' | 'l2'): CacheHit {
    return {
      id: entry.id,
      answer: entry.answer,
      similarity,
      level,
      dependsOn: entry.memoryDeps,
      ...(entry.modelHint ? { modelHint: entry.modelHint } : {}),
    };
  }

  /** The cached answer for a prompt when one is similar enough, else no hit. */
  lookup(
    range: CacheRange,
    scope: CacheScope,
    rawPrompt: string,
    threshold = this.#config.threshold,
  ): Promise<Result<CacheLookup, MindlogError>> {
    return this.#d.tracer.withSpan('cache.lookup', { 'mindlog.tenant': scope.tenant }, async () => {
      const prompt = normalizePrompt(rawPrompt);
      const mvcc = new MvccReader(range.reader);
      const l1 = this.#l1Key(scope, prompt);
      const known = this.#l1.get(l1);
      if (known) {
        const bytes = await mvcc.get(entryKey(scope.tenant, scope.user, known));
        const entry = bytes && fromBinary(CacheEntrySchema, bytes);
        if (entry && entry.prompt === prompt && this.#live(entry)) {
          const hit = SemanticCache.#hit(entry, 1, 'l1');
          this.#count('hit_l1', hit);
          return ok({ hit, degraded: false });
        }
        this.#l1.delete(l1);
      }
      const embedded = await this.#embed(prompt);
      const query: CacheQuery = { prompt, ...(embedded.vector ? { vector: embedded.vector } : {}) };
      // shortcut: a full scan of the scope's entries (≤ maxEntries); index them in a FlatIndex if caches grow.
      let best: { entry: CacheEntry; score: number } | undefined;
      for await (const { value } of mvcc.scan(entryPrefix(scope.tenant, scope.user))) {
        const entry = fromBinary(CacheEntrySchema, value);
        if (!this.#live(entry)) continue;
        const score = similarityOf(query, entry);
        if (!best || score > best.score || (score === best.score && entry.id > best.entry.id))
          best = { entry, score };
      }
      const degraded = !embedded.vector;
      const confirmed = best && (await this.#evaluator.evaluate(query, best.entry));
      if (!best || confirmed === undefined || confirmed < threshold) {
        this.#count('miss');
        return ok({ degraded });
      }
      if (best.entry.prompt === prompt) this.#remember(l1, best.entry.id);
      const hit = SemanticCache.#hit(best.entry, confirmed, 'l2');
      this.#count('hit_l2', hit);
      return ok({ hit, degraded });
    });
  }

  async #propose(
    range: CacheRange,
    command: Command,
  ): Promise<Result<CommandResult, MindlogError>> {
    const proposed = await range.proposer.propose(command);
    if (!proposed.ok) return proposed;
    const outcome = proposed.value.result.outcome;
    if (outcome.case === 'error')
      return err(mindlogError(known(outcome.value.code), outcome.value.message));
    return ok(proposed.value.result);
  }

  /** Stores an answer; without an embedder it is still found by its exact prompt. */
  store(
    range: CacheRange,
    scope: CacheScope,
    input: CacheStoreInput,
    call: CacheCall,
  ): Promise<Result<{ id: string; degraded: boolean }, MindlogError>> {
    return this.#d.tracer.withSpan('cache.store', { 'mindlog.tenant': scope.tenant }, async () => {
      const prompt = normalizePrompt(input.prompt);
      if (prompt === '') return err(mindlogError('INVALID_ARGUMENT', 'prompt is empty'));
      const embedded = await this.#embed(prompt);
      const id = this.#d.ids.next();
      const entry = create(CacheEntrySchema, {
        id,
        prompt,
        vector: embedded.vector ? encodeVector(embedded.vector) : new Uint8Array(),
        embeddingModel: embedded.modelId ?? '',
        answer: input.answer,
        memoryDeps: [...(input.dependsOn ?? [])],
        expiresAtMs: input.ttlSeconds ? this.#d.clock.now() + BigInt(input.ttlSeconds) * 1000n : 0n,
        modelHint: input.modelHint ?? '',
      });
      const command = this.#d.stamper.stamp(
        scope.tenant,
        call.principal,
        {
          case: 'cacheSet',
          value: { user: scope.user, entry, maxEntries: this.#config.maxEntries },
        },
        call.requestId,
      );
      const done = await this.#propose(range, command);
      if (!done.ok) return done;
      // A retried request id gets the first attempt's result, so the stored id comes from it.
      const o = done.value.outcome;
      const stored = (o.case === 'memory' ? o.value.ids[0] : undefined) ?? id;
      this.#remember(this.#l1Key(scope, prompt), stored);
      return ok({ id: stored, degraded: !embedded.vector });
    });
  }

  /** Drops entries by id (CACHE.DEL); returns how many existed. */
  async invalidate(
    range: CacheRange,
    scope: CacheScope,
    ids: readonly string[],
    call: CacheCall,
  ): Promise<Result<{ count: number }, MindlogError>> {
    const command = this.#d.stamper.stamp(
      scope.tenant,
      call.principal,
      { case: 'cacheInvalidate', value: { user: scope.user, ids: [...ids] } },
      call.requestId,
    );
    const done = await this.#propose(range, command);
    if (!done.ok) return done;
    const o = done.value.outcome;
    return ok({ count: o.case === 'memory' ? o.value.count : 0 });
  }
}
