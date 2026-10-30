import type { MindlogError, MindlogErrorCode, Result } from '@mindlog/core';
import {
  ERROR_CODES,
  isUserTenant,
  KeyFamily,
  decodeKey,
  err,
  keyPrefix,
  mindlogError,
  ok,
  prefixRange,
} from '@mindlog/core';
import type { CacheHit, SemanticCache } from '@mindlog/cache';
import { replies } from '@mindlog/kv';
import type {
  GraphView,
  HistoryEntry,
  MemoryEngine,
  MemoryRange,
  MemoryScope,
  MemoryView,
  RecallOutput,
  RememberOutput,
} from '@mindlog/memory';
import { scopeKey } from '@mindlog/memory';
import type { KvReply } from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import type { z } from 'zod';
import type { Caller, Placement, RangeCall, RangeRouter, RangeTarget } from '../kv/range-router.js';
import type {
  CacheDeleteRequest,
  CacheLookupRequest,
  CacheStoreRequest,
  ForgetRequest,
  GetMemoryRequest,
  GraphRequest,
  HistoryRequest,
  ListMemoryRequest,
  RecallRequest,
  RememberRequest,
  ScopesRequest,
} from './schemas.js';
import {
  cacheDeleteSchema,
  cacheLookupSchema,
  cacheStoreSchema,
  forgetSchema,
  getMemorySchema,
  graphSchema,
  historySchema,
  listMemorySchema,
  recallSchema,
  rememberSchema,
  scopesSchema,
} from './schemas.js';

/** Cluster version that knows the memory and job commands (ADR-0032, PLAN 19.5). */
export const MEMORY_CLUSTER_VERSION = 5;
/** Cluster version that knows the cache commands (ADR-0012). */
export const CACHE_CLUSTER_VERSION = 6;

export interface MemoryServiceDeps {
  readonly engine: MemoryEngine;
  /** The semantic cache; without it the cache operations answer UNIMPLEMENTED. */
  readonly cache?: SemanticCache;
  readonly router: RangeRouter;
  readonly stamper: CommandStamper;
  /** The cluster version PD reports; writes need `MEMORY_CLUSTER_VERSION`. Absent: always met. */
  readonly clusterVersion?: () => number;
}

interface Engines {
  readonly memory: MemoryEngine;
  readonly cache: SemanticCache | undefined;
}

interface Op<S extends z.ZodType, O> {
  readonly schema: S;
  readonly write: boolean;
  /** Cluster version a write needs (default `MEMORY_CLUSTER_VERSION`). */
  readonly version?: number;
  run(
    engines: Engines,
    range: MemoryRange,
    scope: MemoryScope,
    input: z.output<S>,
    ctx: { principal: string; requestId?: Uint8Array },
  ): Promise<Result<O, MindlogError>>;
}

const op = <S extends z.ZodType, O>(o: Op<S, O>): Op<S, O> => o;

const OPS = {
  remember: op({
    schema: rememberSchema,
    write: true,
    run: ({ memory: e }, r, scope, i, c) =>
      e.remember(r, { ...i, scope } as Parameters<MemoryEngine['remember']>[1], c),
  }),
  recall: op({
    schema: recallSchema,
    write: false,
    run: ({ memory: e }, r, scope, i, c) =>
      e.recall(r, { ...i, scope } as Parameters<MemoryEngine['recall']>[1], c),
  }),
  get: op({
    schema: getMemorySchema,
    write: false,
    run: ({ memory: e }, r, scope, i) => e.get(r, scope, i.id),
  }),
  list: op({
    schema: listMemorySchema,
    write: false,
    run: ({ memory: e }, r, scope, i) =>
      e.list(r, scope, {
        limit: i.limit,
        ...(i.after ? { after: i.after } : {}),
        ...(i.kind ? { kind: i.kind } : {}),
        ...(i.includeForgotten ? { includeForgotten: true } : {}),
      }),
  }),
  forget: op({
    schema: forgetSchema,
    write: true,
    run: ({ memory: e }, r, scope, i, c) =>
      e.forget(r, { scope, ids: i.ids, ...(i.reason ? { reason: i.reason } : {}) }, c),
  }),
  history: op({
    schema: historySchema,
    write: false,
    run: ({ memory: e }, r, scope, i) => e.history(r, scope, i.id),
  }),
  graph: op({
    schema: graphSchema,
    write: false,
    run: ({ memory: e }, r, scope, i) => e.graph(r, scope, i.entity, i.depth),
  }),
  cacheGet: op({
    schema: cacheLookupSchema,
    write: false,
    run: async (
      { cache },
      r,
      scope,
      i,
    ): Promise<Result<{ hit: CacheHit | null; degraded: boolean }, MindlogError>> => {
      if (!cache) return err(mindlogError('UNIMPLEMENTED', 'the semantic cache is not available'));
      const found = await cache.lookup(r, scope, i.prompt, i.threshold);
      return found.ok
        ? ok({ hit: found.value.hit ?? null, degraded: found.value.degraded })
        : found;
    },
  }),
  cacheSet: op({
    schema: cacheStoreSchema,
    write: true,
    version: CACHE_CLUSTER_VERSION,
    run: ({ cache }, r, scope, i, c) =>
      cache
        ? cache.store(
            r,
            scope,
            {
              prompt: i.prompt,
              answer: i.answer,
              ...(i.dependsOn ? { dependsOn: i.dependsOn } : {}),
              ...(i.ttlSeconds ? { ttlSeconds: i.ttlSeconds } : {}),
              ...(i.modelHint ? { modelHint: i.modelHint } : {}),
            },
            c,
          )
        : Promise.resolve(
            err(mindlogError('UNIMPLEMENTED', 'the semantic cache is not available')),
          ),
  }),
  cacheDel: op({
    schema: cacheDeleteSchema,
    write: true,
    version: CACHE_CLUSTER_VERSION,
    run: ({ cache }, r, scope, i, c) =>
      cache
        ? cache.invalidate(r, scope, i.ids, c)
        : Promise.resolve(
            err(mindlogError('UNIMPLEMENTED', 'the semantic cache is not available')),
          ),
  }),
};

type Ops = typeof OPS;
type OpName = keyof Ops;
type OutputOf<N extends OpName> = Ops[N] extends Op<z.ZodType, infer O> ? O : never;

const CODES = new Set(Object.keys(ERROR_CODES));
const known = (code: string): MindlogErrorCode =>
  CODES.has(code) ? (code as MindlogErrorCode) : 'INTERNAL';
const RETRYABLE = new Set(['NOT_LEADER', 'RANGE_MOVED']);
const PLACE_RETRYABLE = new Set(['NOT_FOUND', 'NOT_LEADER', 'RANGE_MOVED', 'UNAVAILABLE']);
const MAX_RETRIES = 10;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoff = (attempt: number) =>
  delay(Math.min(25 * 2 ** attempt, 400) * (0.5 + Math.random()));

function invalid(issues: z.core.$ZodIssue[]): MindlogError {
  return mindlogError(
    'INVALID_ARGUMENT',
    issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
    {
      fields: Object.fromEntries(issues.map((i) => [i.path.join('.') || '_', i.message])),
    },
  );
}

/**
 * Memory requests from every interface (PLAN 12.1, 15): validates them, finds
 * the range of the user scope and runs the engine on its leader, here or on
 * the node that leads it (ADR-0016). Retries keep the request id, so a write
 * that did commit is not applied twice.
 */
export class MemoryService {
  readonly #d: MemoryServiceDeps;

  constructor(deps: MemoryServiceDeps) {
    this.#d = deps;
  }

  remember(caller: Caller, input: RememberRequest): Promise<Result<RememberOutput, MindlogError>> {
    return this.#execute(caller, 'remember', input);
  }

  recall(caller: Caller, input: RecallRequest): Promise<Result<RecallOutput, MindlogError>> {
    return this.#execute(caller, 'recall', input);
  }

  get(
    caller: Caller,
    input: GetMemoryRequest,
  ): Promise<Result<MemoryView | undefined, MindlogError>> {
    return this.#execute(caller, 'get', input);
  }

  list(
    caller: Caller,
    input: ListMemoryRequest,
  ): Promise<Result<{ memories: MemoryView[]; next?: string }, MindlogError>> {
    return this.#execute(caller, 'list', input);
  }

  forget(
    caller: Caller,
    input: ForgetRequest,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#execute(caller, 'forget', input);
  }

  history(caller: Caller, input: HistoryRequest): Promise<Result<HistoryEntry[], MindlogError>> {
    return this.#execute(caller, 'history', input);
  }

  graph(caller: Caller, input: GraphRequest): Promise<Result<GraphView, MindlogError>> {
    return this.#execute(caller, 'graph', input);
  }

  /** The cached answer for a similar prompt in the user scope, or `hit: null` (PLAN 13.9). */
  cacheLookup(
    caller: Caller,
    input: CacheLookupRequest,
  ): Promise<Result<{ hit: CacheHit | null; degraded: boolean }, MindlogError>> {
    return this.#execute(caller, 'cacheGet', input);
  }

  /** Caches an answer with the memories it depends on. */
  cacheStore(
    caller: Caller,
    input: CacheStoreRequest,
  ): Promise<Result<{ id: string; degraded: boolean }, MindlogError>> {
    return this.#execute(caller, 'cacheSet', input);
  }

  cacheDelete(
    caller: Caller,
    input: CacheDeleteRequest,
  ): Promise<Result<{ count: number }, MindlogError>> {
    return this.#execute(caller, 'cacheDel', input);
  }

  /**
   * User scopes of the tenant that hold memory, from the ranges this node holds a replica of.
   *
   * shortcut: only ranges with a replica here, so a cluster lists part of its scopes; forward to each range when dashboards run on clusters.
   */
  async scopes(
    caller: Caller,
    input: ScopesRequest,
  ): Promise<Result<{ users: string[] }, MindlogError>> {
    const parsed = scopesSchema.safeParse(input);
    if (!parsed.success) return err(invalid(parsed.error.issues));
    const ranges = await this.#d.router.ranges();
    if (!ranges.ok) return ranges;
    const family = keyPrefix(caller.tenant, KeyFamily.MEMORY);
    if (!family.ok) return family;
    const users = new Set<string>();
    for (const p of ranges.value) {
      // The router names ranges; this node reads only those it holds a replica of.
      const local = p.local ?? this.#d.router.local(p.rangeId);
      if (!local) continue;
      let start = family.value;
      const end = prefixRange(family.value).end;
      for (;;) {
        let next: Uint8Array | undefined;
        for await (const [key] of local.reader.iterate({ start, end }, { limit: 1 })) {
          const decoded = decodeKey(key);
          const user = decoded.ok ? decoded.value.tuple[0] : undefined;
          if (typeof user !== 'string') break;
          users.add(user);
          next = prefixRange(scopeKey(caller.tenant, user)).end;
        }
        if (!next || users.size >= parsed.data.limit) break;
        start = next;
      }
    }
    return ok({ users: [...users].sort().slice(0, parsed.data.limit) });
  }

  async #execute<N extends OpName>(
    caller: Caller,
    name: N,
    raw: unknown,
  ): Promise<Result<OutputOf<N>, MindlogError>> {
    const spec = OPS[name] as unknown as Op<z.ZodType, OutputOf<N>>;
    if (!isUserTenant(caller.tenant))
      return err(
        mindlogError('INVALID_ARGUMENT', `memory is not available in tenant ${caller.tenant}`),
      );
    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success) return err(invalid(parsed.error.issues));
    const input = parsed.data as { scope: { user: string } };
    if (
      spec.write &&
      this.#d.clusterVersion &&
      this.#d.clusterVersion() < (spec.version ?? MEMORY_CLUSTER_VERSION)
    )
      return err(
        mindlogError(
          'UNAVAILABLE',
          `the cluster has not reached the version of ${name} commands yet; retry`,
        ),
      );
    const requestId = spec.write
      ? this.#d.stamper.stamp(caller.tenant, caller.principal, {
          case: 'memoryForget',
          value: { user: '', ids: [], reason: '' },
        }).requestId
      : undefined;
    const key = scopeKey(caller.tenant, input.scope.user);
    let placed = await this.#locate(key);
    for (let attempt = 0; ; attempt++) {
      if (!placed.ok) return placed;
      const result = await this.#once(placed.value, caller, name, spec, input, requestId);
      if (result.ok || !RETRYABLE.has(result.error.code) || attempt >= MAX_RETRIES) return result;
      await backoff(attempt);
      placed = this.#d.router.refresh
        ? await this.#d.router.refresh(placed.value)
        : await this.#locate(key);
    }
  }

  async #locate(key: Uint8Array): Promise<Result<Placement, MindlogError>> {
    for (let attempt = 0; ; attempt++) {
      const placed = await this.#d.router.locate(key);
      if (placed.ok || !PLACE_RETRYABLE.has(placed.error.code) || attempt >= MAX_RETRIES)
        return placed;
      await backoff(attempt);
    }
  }

  async #once<O>(
    placement: Placement,
    caller: Caller,
    name: OpName,
    spec: Op<z.ZodType, O>,
    input: unknown,
    requestId: Uint8Array | undefined,
  ): Promise<Result<O, MindlogError>> {
    const call: RangeCall = {
      kind: 'memory',
      op: name,
      json: JSON.stringify(input),
      ...(requestId ? { requestId } : {}),
    };
    if (placement.local) return this.#local(placement.local, caller, spec, input, requestId);
    const reply = await this.#d.router.forward(placement, caller, call);
    if (!reply.ok) return reply;
    const kind = reply.value.kind;
    if (kind.case === 'error') return err(mindlogError(known(kind.value.code), kind.value.message));
    if (kind.case !== 'bulk')
      return err(mindlogError('INTERNAL', 'forwarded memory call returned no result'));
    return ok(JSON.parse(decoder.decode(kind.value)) as O);
  }

  async #local<O>(
    target: RangeTarget,
    caller: Caller,
    spec: Op<z.ZodType, O>,
    input: unknown,
    requestId: Uint8Array | undefined,
  ): Promise<Result<O, MindlogError>> {
    const { scope } = input as { scope: { user: string; agent?: string; session?: string } };
    if (!spec.write) {
      const ready = await target.readBarrier.read('lease');
      if (!ready.ok) return ready;
    }
    if (!target.covers(scopeKey(caller.tenant, scope.user)))
      return err(mindlogError('RANGE_MOVED', `the scope left range ${String(target.rangeId)}`));
    const range: MemoryRange = {
      rangeId: target.rangeId,
      proposer: target.proposer,
      reader: target.reader,
    };
    const engines = { memory: this.#d.engine, cache: this.#d.cache };
    return spec.run(engines, range, { tenant: caller.tenant, ...scope }, input, {
      principal: caller.principal,
      ...(requestId ? { requestId } : {}),
    });
  }

  /** Runs a memory call another node forwarded here (ADR-0016); the input is validated again. */
  async forwarded(rangeId: bigint, caller: Caller, call: RangeCall): Promise<KvReply> {
    if (call.kind !== 'memory') return replies.error('INVALID_ARGUMENT', 'not a memory call');
    const target = this.#d.router.local(rangeId);
    if (!target)
      return replies.error('RANGE_MOVED', `this node holds no replica of range ${String(rangeId)}`);
    const spec = (OPS as Record<string, Op<z.ZodType, unknown> | undefined>)[call.op];
    if (!spec) return replies.error('INVALID_ARGUMENT', `unknown memory operation ${call.op}`);
    let raw: unknown;
    try {
      raw = JSON.parse(call.json);
    } catch {
      return replies.error('INVALID_ARGUMENT', 'malformed memory call');
    }
    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success)
      return replies.error('INVALID_ARGUMENT', invalid(parsed.error.issues).message);
    const result = await this.#local(target, caller, spec, parsed.data, call.requestId);
    return result.ok
      ? replies.bulk(encoder.encode(JSON.stringify(result.value ?? null)))
      : replies.error(result.error.code, result.error.message);
  }
}
