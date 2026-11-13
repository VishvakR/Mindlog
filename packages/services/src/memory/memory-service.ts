import { createHash } from 'node:crypto';
import type { Clock, Hlc, MindlogError, MindlogErrorCode, Result } from '@mindlog/core';
import {
  ERROR_CODES,
  SystemClock,
  hlcPhysical,
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
  ConflictView,
  BranchDiff,
  BranchView,
  MergeResult,
  RecallOutput,
  RememberOutput,
  JobView,
  LifecycleJob,
  LifecycleView,
} from '@mindlog/memory';
import type { RedactionKind } from '@mindlog/memory';
import {
  MAX_CLUSTERS,
  SPLIT_JOB,
  baseUser,
  clusterUser,
  scopeKey,
  toJobView,
  toLifecycleView,
} from '@mindlog/memory';
import { create, fromBinary } from '@bufbuild/protobuf';
import type { KvReply } from '@mindlog/proto';
import { JobState, NewMemorySchema, ScopeClusterSchema } from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import { z } from 'zod';
import type { Access } from '@mindlog/auth';
import type { Caller, Placement, RangeCall, RangeRouter, RangeTarget } from '../kv/range-router.js';
import type { Authorize } from '../tenants/authorize.js';
import type { AdmitClass } from '../tenants/governor.js';
import { ScopeSplits } from './scope-splits.js';
import { modelTenant } from '../tenants/model-meter.js';
import type {
  CacheDeleteRequest,
  CacheLookupRequest,
  CacheStoreRequest,
  ForgetRequest,
  GetManyRequest,
  GetMemoryRequest,
  GraphRequest,
  HistoryRequest,
  ListMemoryRequest,
  RecallRequest,
  RememberRequest,
  ResolveRequest,
  ScopesRequest,
  ConflictsRequest,
  TrustRequest,
  BranchRequest,
  BranchesRequest,
  MergeRequest,
  ConsolidateRequest,
  ExportRequest,
  ImportRequest,
  JobsRequest,
  PinRequest,
} from './schemas.js';
import {
  cacheDeleteSchema,
  cacheLookupSchema,
  getManySchema,
  memoryScopeSchema,
  cacheStoreSchema,
  conflictsSchema,
  forgetSchema,
  getMemorySchema,
  graphSchema,
  historySchema,
  listMemorySchema,
  recallSchema,
  rememberSchema,
  resolveSchema,
  scopesSchema,
  toAsOf,
  trustSchema,
  branchSchema,
  branchesSchema,
  mergeSchema,
  consolidateSchema,
  exportSchema,
  importSchema,
  jobsSchema,
  pinSchema,
} from './schemas.js';

/** Cluster version that knows the memory and job commands (ADR-0032, PLAN 19.5). */
export const MEMORY_CLUSTER_VERSION = 5;
/** Cluster version that knows the cache commands (ADR-0012). */
export const CACHE_CLUSTER_VERSION = 6;
/** Cluster version that knows conflict review, trust and branch commands (ADR-0013, ADR-0015). */
export const LOG_NATIVE_CLUSTER_VERSION = 7;
/** Cluster version that knows the lifecycle commands (ADR-0033). */
export const LIFECYCLE_CLUSTER_VERSION = 8;
/** Cluster version that knows `MemoryRehome` (ADR-0039). */
export const SPLIT_CLUSTER_VERSION = 10;

const JOB_STATES = {
  queued: JobState.QUEUED,
  leased: JobState.LEASED,
  dead: JobState.DEAD,
} as const;

/** What an operation costs: only growth and recall count; forgetting frees room. */
function admitClass(name: string): AdmitClass {
  if (name === 'remember' || name === 'import') return 'memory';
  return name === 'recall' ? 'recall' : 'free';
}

export interface MemoryServiceDeps {
  readonly engine: MemoryEngine;
  /** The semantic cache; without it the cache operations answer UNIMPLEMENTED. */
  readonly cache?: SemanticCache;
  readonly router: RangeRouter;
  readonly stamper: CommandStamper;
  /** The cluster version PD reports; writes need `MEMORY_CLUSTER_VERSION`. Absent: always met. */
  readonly clusterVersion?: () => number;
  /** Authorizes callers that carry an `access` (PLAN 18.2). */
  readonly authorize?: Authorize;
  /** Per-tenant admission (PLAN 18.3). */
  readonly admit?: (tenant: string, cls: AdmitClass) => Promise<Result<void, MindlogError>>;
  /** The tenant's redaction policy (PLAN 12.3 stage 2), looked up where ingestion runs. */
  readonly redaction?: (tenant: string) => Promise<readonly RedactionKind[]>;
  /** For the split layout cache; the system clock by default. */
  readonly clock?: Clock;
  /** Clusters a recall of a split scope searches (`memory.split.recallClusters`); 2 by default. */
  readonly splitFanout?: number;
}

/** Who is asking. Interfaces pass `access`; the node's own workers do not. */
export interface MemoryCaller extends Caller {
  readonly access?: Access;
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
    ctx: { principal: string; requestId?: Uint8Array; redact?: readonly RedactionKind[] },
  ): Promise<Result<O, MindlogError>>;
}

const op = <S extends z.ZodType, O>(o: Op<S, O>): Op<S, O> => o;

const OPS = {
  remember: op({
    schema: rememberSchema,
    write: true,
    run: ({ memory: e }, r, scope, { validFrom, validTo, requestId: _id, ...i }, c) =>
      e.remember(
        r,
        {
          ...i,
          scope,
          ...(validFrom === undefined ? {} : { validFromMs: validFrom }),
          ...(validTo === undefined ? {} : { validToMs: validTo }),
        } as Parameters<MemoryEngine['remember']>[1],
        c,
      ),
  }),
  recall: op({
    schema: recallSchema,
    write: false,
    run: ({ memory: e }, r, scope, { validAt, asOf, ...i }, c) =>
      e.recall(
        r,
        {
          ...i,
          scope,
          ...(asOf ? { asOf: toAsOf(asOf) } : {}),
          ...(validAt === undefined ? {} : { validAtMs: validAt }),
        } as Parameters<MemoryEngine['recall']>[1],
        c,
      ),
  }),
  get: op({
    schema: getMemorySchema,
    write: false,
    run: ({ memory: e }, r, scope, i) =>
      e.get(r, scope, i.id, { asOf: toAsOf(i.asOf), branch: i.branch }),
  }),
  getMany: op({
    schema: getManySchema,
    write: false,
    run: async ({ memory: e }, r, scope, i) => {
      const out: MemoryView[] = [];
      for (const id of i.ids) {
        const got = await e.get(r, scope, id, {});
        if (!got.ok) return got;
        if (got.value) out.push(got.value);
      }
      return ok({ memories: out });
    },
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
        ...(i.asOf ? { asOf: toAsOf(i.asOf) } : {}),
        ...(i.branch ? { branch: i.branch } : {}),
      }),
  }),
  forget: op({
    schema: forgetSchema,
    write: true,
    run: ({ memory: e }, r, scope, i, c) =>
      e.forget(
        r,
        {
          scope,
          ids: i.ids,
          ...(i.reason ? { reason: i.reason } : {}),
          ...(i.source ? { sourceRef: i.source } : {}),
          ...(i.branch ? { branch: i.branch } : {}),
        },
        c,
      ),
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
  conflicts: op({
    schema: conflictsSchema,
    write: false,
    run: ({ memory: e }, r, scope, i) =>
      e.conflicts(r, scope, { all: i.status === 'all', limit: i.limit, after: i.after }),
  }),
  resolve: op({
    schema: resolveSchema,
    write: true,
    version: LOG_NATIVE_CLUSTER_VERSION,
    run: ({ memory: e }, r, scope, i, c) =>
      e.resolve(
        r,
        {
          scope,
          id: i.id,
          keep: i.keep,
          ...(i.validFrom === undefined ? {} : { validFromMs: i.validFrom }),
        },
        c,
      ),
  }),
  trust: op({
    schema: trustSchema,
    write: true,
    version: LOG_NATIVE_CLUSTER_VERSION,
    run: ({ memory: e }, r, scope, i, c) =>
      e.setTrust(
        r,
        {
          scope,
          ids: i.ids,
          trust: i.trust,
          ...(i.reason ? { reason: i.reason } : {}),
          ...(i.branch ? { branch: i.branch } : {}),
        },
        c,
      ),
  }),
  branchCreate: op({
    schema: branchSchema,
    write: true,
    version: LOG_NATIVE_CLUSTER_VERSION,
    run: ({ memory: e }, r, scope, i, c) => e.createBranch(r, scope, i.name, c),
  }),
  branches: op({
    schema: branchesSchema,
    write: false,
    run: ({ memory: e }, r, scope) => e.branches(r, scope),
  }),
  branchDiff: op({
    schema: branchSchema,
    write: false,
    run: ({ memory: e }, r, scope, i) => e.diffBranch(r, scope, i.name),
  }),
  branchMerge: op({
    schema: mergeSchema,
    write: true,
    version: LOG_NATIVE_CLUSTER_VERSION,
    run: ({ memory: e }, r, scope, i, c) =>
      e.mergeBranch(r, { scope, name: i.name, policy: i.policy }, c),
  }),
  branchDrop: op({
    schema: branchSchema,
    write: true,
    version: LOG_NATIVE_CLUSTER_VERSION,
    run: ({ memory: e }, r, scope, i, c) => e.dropBranch(r, scope, i.name, c),
  }),
  pin: op({
    schema: pinSchema,
    write: true,
    version: LIFECYCLE_CLUSTER_VERSION,
    run: ({ memory: e }, r, scope, i, c) => e.pin(r, scope, i.ids, i.pinned, c),
  }),
  consolidate: op({
    schema: consolidateSchema,
    write: true,
    version: LIFECYCLE_CLUSTER_VERSION,
    run: ({ memory: e }, r, scope, i, c) =>
      e.consolidate(
        r,
        scope,
        i.workers?.map((w) => (w === 'split' ? SPLIT_JOB : `consolidation.${w}`) as LifecycleJob),
        c,
      ),
  }),
  jobs: op({
    schema: jobsSchema,
    write: false,
    run: async (
      { memory: e },
      r,
      scope,
      i,
    ): Promise<
      Result<{ jobs: JobView[]; lifecycle: LifecycleView; next?: string }, MindlogError>
    > => {
      const page = await e.jobs(r, scope, {
        limit: i.limit,
        ...(i.state ? { state: JOB_STATES[i.state] } : {}),
        ...(i.after ? { after: i.after } : {}),
      });
      const lifecycle = toLifecycleView(await e.lifecycle(r, scope), e.coldTier);
      return ok({
        jobs: page.jobs.map(toJobView),
        lifecycle,
        ...(page.next ? { next: page.next } : {}),
      });
    },
  }),
  export: op({
    schema: exportSchema,
    write: false,
    run: async (
      { memory: e },
      r,
      scope,
      i,
    ): Promise<Result<{ data: string; bytes: number }, MindlogError>> => {
      const cube = await e.exportCube(r, scope, toAsOf(i.asOf));
      // Base64, so the result travels as JSON between nodes like every other.
      return cube.ok
        ? ok({ data: Buffer.from(cube.value).toString('base64'), bytes: cube.value.length })
        : cube;
    },
  }),
  import: op({
    schema: importSchema,
    write: true,
    version: LIFECYCLE_CLUSTER_VERSION,
    run: ({ memory: e }, r, scope, i, c) => {
      const bytes = new Uint8Array(Buffer.from(i.data, 'base64'));
      if (bytes.length > 32 * 1024 * 1024)
        return Promise.resolve(err(mindlogError('PAYLOAD_TOO_LARGE', 'the archive is over 32 MB')));
      return e.importCube(r, scope, { bytes, format: i.format, name: i.name }, c);
    },
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

const clusterSchema = z.strictObject({
  id: z.int().min(0),
  centroid: z.string().max(65_536),
  spread: z.number(),
});

/**
 * Operations the service runs on one cluster of a split scope (ADR-0039).
 * Never reachable from an interface: only `ScopeSplits` and the split worker
 * call them, here or on the node a call is forwarded to.
 */
const INTERNAL_OPS = {
  layout: op({
    schema: z.strictObject({ scope: memoryScopeSchema }),
    write: false,
    run: async ({ memory: e }, r, scope) =>
      ok({ clusters: (await e.split.clusters(r, scope)).map((c) => c.id).sort((a, b) => a - b) }),
  }),
  clusters: op({
    schema: z.strictObject({ scope: memoryScopeSchema }),
    write: false,
    run: async ({ memory: e }, r, scope) =>
      ok({
        clusters: (await e.split.clusters(r, scope)).map((c) => ({
          id: c.id,
          centroid: Buffer.from(c.centroid).toString('base64'),
          spread: c.spread,
        })),
      }),
  }),
  route: op({
    schema: z.strictObject({
      scope: memoryScopeSchema,
      text: z.string().max(65_536),
      kind: z.enum(['query', 'passage']),
    }),
    write: false,
    run: async ({ memory: e }, r, scope, i) => {
      const routed = await e.split.route(r, scope, i.text, i.kind);
      return routed.ok
        ? ok({ clusters: routed.value.clusters, degraded: routed.value.degraded })
        : routed;
    },
  }),
  asOfTime: op({
    schema: z.strictObject({ scope: memoryScopeSchema, index: z.string().regex(/^\d{1,20}$/) }),
    write: false,
    run: async ({ memory: e }, r, scope, i) =>
      ok({
        time: Number(hlcPhysical((await e.versionAt(r, scope, { index: BigInt(i.index) })) as Hlc)),
      }),
  }),
  derived: op({
    schema: z.strictObject({
      scope: memoryScopeSchema,
      ids: z.array(z.string().max(64)).max(10_000),
    }),
    write: false,
    run: async ({ memory: e }, r, scope, i) => ok(await e.split.derived(r, scope, i.ids)),
  }),
  exportParts: op({
    schema: exportSchema,
    write: false,
    run: async ({ memory: e }, r, scope, i) => {
      const parts = await e.exportParts(r, scope, toAsOf(i.asOf));
      return parts.ok
        ? ok({ ...parts.value, asOfVersion: String(parts.value.asOfVersion) })
        : parts;
    },
  }),
  rehome: op({
    schema: z.strictObject({
      scope: memoryScopeSchema,
      setLayout: z.boolean().optional(),
      layout: z.array(clusterSchema).max(MAX_CLUSTERS).optional(),
      /** `NewMemory` messages, base64. */
      copies: z.array(z.string()).max(1_000).optional(),
      moved: z.array(z.string().max(64)).max(1_000).optional(),
      movedTo: z.string().max(256).optional(),
    }),
    write: true,
    version: SPLIT_CLUSTER_VERSION,
    run: ({ memory: e }, r, scope, i, c) =>
      e.split.rehome(
        r,
        scope,
        {
          ...(i.setLayout ? { setLayout: true } : {}),
          ...(i.layout
            ? {
                layout: i.layout.map((l) =>
                  create(ScopeClusterSchema, {
                    id: l.id,
                    centroid: new Uint8Array(Buffer.from(l.centroid, 'base64')),
                    spread: l.spread,
                  }),
                ),
              }
            : {}),
          ...(i.copies
            ? { copies: i.copies.map((b) => fromBinary(NewMemorySchema, Buffer.from(b, 'base64'))) }
            : {}),
          ...(i.moved ? { moved: i.moved } : {}),
          ...(i.movedTo ? { movedTo: i.movedTo } : {}),
        },
        c,
      ),
  }),
};

const ALL_OPS = { ...OPS, ...INTERNAL_OPS };

/** A request id per cluster: clusters may share a range, whose idempotency table must not merge them. */
const clusterRequestId = (id: Uint8Array | undefined, cluster: number): Uint8Array | undefined =>
  id && cluster > 0 ? Uint8Array.of(...id, cluster) : id;

/** A caller's request id as an idempotency key: scoped to the tenant and principal that sent it. */
const clientRequestKey = (caller: Caller, id: string): Uint8Array =>
  new Uint8Array(
    createHash('sha256').update(`${caller.tenant}\u0000${caller.principal}\u0000${id}`).digest(),
  ).slice(0, 16);

/** `recall#2`: the operation and the cluster it runs on. */
function parseOp(op: string): { name: string; cluster: number } {
  const at = op.lastIndexOf('#');
  return at < 0
    ? { name: op, cluster: 0 }
    : { name: op.slice(0, at), cluster: Number(op.slice(at + 1)) };
}

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
  readonly #splits: ScopeSplits;

  constructor(deps: MemoryServiceDeps) {
    this.#d = deps;
    this.#splits = new ScopeSplits(deps.clock ?? new SystemClock(), deps.splitFanout);
  }

  remember(
    caller: MemoryCaller,
    input: RememberRequest,
  ): Promise<Result<RememberOutput, MindlogError>> {
    return this.#execute(caller, 'remember', input);
  }

  recall(caller: MemoryCaller, input: RecallRequest): Promise<Result<RecallOutput, MindlogError>> {
    return this.#execute(caller, 'recall', input);
  }

  get(
    caller: MemoryCaller,
    input: GetMemoryRequest,
  ): Promise<Result<MemoryView | undefined, MindlogError>> {
    return this.#execute(caller, 'get', input);
  }

  list(
    caller: MemoryCaller,
    input: ListMemoryRequest,
  ): Promise<Result<{ memories: MemoryView[]; next?: string }, MindlogError>> {
    return this.#execute(caller, 'list', input);
  }

  forget(
    caller: MemoryCaller,
    input: ForgetRequest,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#execute(caller, 'forget', input);
  }

  getMany(
    caller: MemoryCaller,
    input: GetManyRequest,
  ): Promise<Result<{ memories: MemoryView[] }, MindlogError>> {
    return this.#execute(caller, 'getMany', input);
  }

  history(
    caller: MemoryCaller,
    input: HistoryRequest,
  ): Promise<Result<HistoryEntry[], MindlogError>> {
    return this.#execute(caller, 'history', input);
  }

  graph(caller: MemoryCaller, input: GraphRequest): Promise<Result<GraphView, MindlogError>> {
    return this.#execute(caller, 'graph', input);
  }

  /** Conflicts of a user scope, open ones by default (ADR-0015). */
  conflicts(
    caller: MemoryCaller,
    input: ConflictsRequest,
  ): Promise<Result<{ conflicts: ConflictView[]; next?: string }, MindlogError>> {
    return this.#execute(caller, 'conflicts', input);
  }

  /** Resolves a conflict: the loser's validity ends, the winner leaves quarantine. */
  resolve(
    caller: MemoryCaller,
    input: ResolveRequest,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#execute(caller, 'resolve', input);
  }

  /** Sets the trust of memories, e.g. to release reviewed quarantined content (PLAN 13.4). */
  trust(
    caller: MemoryCaller,
    input: TrustRequest,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#execute(caller, 'trust', input);
  }

  /** Creates a branch of a user scope that reads main as of now (ADR-0013). */
  createBranch(
    caller: MemoryCaller,
    input: BranchRequest,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#execute(caller, 'branchCreate', input);
  }

  branches(
    caller: MemoryCaller,
    input: BranchesRequest,
  ): Promise<Result<BranchView[], MindlogError>> {
    return this.#execute(caller, 'branches', input);
  }

  /** What a branch added, forgot and changed relative to main at its fork. */
  diffBranch(
    caller: MemoryCaller,
    input: BranchRequest,
  ): Promise<Result<BranchDiff, MindlogError>> {
    return this.#execute(caller, 'branchDiff', input);
  }

  /** Merges a branch into main under a conflict policy. */
  mergeBranch(
    caller: MemoryCaller,
    input: MergeRequest,
  ): Promise<Result<MergeResult, MindlogError>> {
    return this.#execute(caller, 'branchMerge', input);
  }

  dropBranch(
    caller: MemoryCaller,
    input: BranchRequest,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#execute(caller, 'branchDrop', input);
  }

  /** Pins or unpins memories (exempt from the cold tier and hard forgetting, PLAN 13.7). */
  pin(
    caller: MemoryCaller,
    input: PinRequest,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#execute(caller, 'pin', input);
  }

  /** Enqueues consolidation workers for the scope now (ADR-0033). */
  consolidate(
    caller: MemoryCaller,
    input: ConsolidateRequest,
  ): Promise<Result<{ enqueued: string[] }, MindlogError>> {
    return this.#execute(caller, 'consolidate', input);
  }

  /** The scope's jobs and lifecycle state (Jobs page). */
  jobs(
    caller: MemoryCaller,
    input: JobsRequest,
  ): Promise<Result<{ jobs: JobView[]; lifecycle: LifecycleView; next?: string }, MindlogError>> {
    return this.#execute(caller, 'jobs', input);
  }

  /** The scope as a `.mcube` archive, base64 (PLAN 13.11). */
  exportCube(
    caller: MemoryCaller,
    input: ExportRequest,
  ): Promise<Result<{ data: string; bytes: number }, MindlogError>> {
    return this.#execute(caller, 'export', input);
  }

  /** Imports a `.mcube` or COGX archive into the scope; memories follow the trust policy. */
  importCube(
    caller: MemoryCaller,
    input: ImportRequest,
  ): Promise<Result<{ imported: number; skipped: number; ids: string[] }, MindlogError>> {
    return this.#execute(caller, 'import', input);
  }

  /** The cached answer for a similar prompt in the user scope, or `hit: null` (PLAN 13.9). */
  cacheLookup(
    caller: MemoryCaller,
    input: CacheLookupRequest,
  ): Promise<Result<{ hit: CacheHit | null; degraded: boolean }, MindlogError>> {
    return this.#execute(caller, 'cacheGet', input);
  }

  /** Caches an answer with the memories it depends on. */
  cacheStore(
    caller: MemoryCaller,
    input: CacheStoreRequest,
  ): Promise<Result<{ id: string; degraded: boolean }, MindlogError>> {
    return this.#execute(caller, 'cacheSet', input);
  }

  cacheDelete(
    caller: MemoryCaller,
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
    caller: MemoryCaller,
    input: ScopesRequest,
  ): Promise<Result<{ users: string[] }, MindlogError>> {
    const parsed = scopesSchema.safeParse(input);
    if (!parsed.success) return err(invalid(parsed.error.issues));
    // No target scope: a caller limited to some scopes cannot list them all.
    const allowed = await this.#authorize(caller, false, undefined);
    if (!allowed.ok) return allowed;
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
          // A split scope's clusters list as the one scope (ADR-0039).
          users.add(baseUser(user));
          next = prefixRange(scopeKey(caller.tenant, user)).end;
        }
        if (!next || users.size >= parsed.data.limit) break;
        start = next;
      }
    }
    return ok({ users: [...users].sort().slice(0, parsed.data.limit) });
  }

  /** Refuses a caller outside its role, tenant or scopes; internal callers carry no `access`. */
  async #authorize(
    caller: MemoryCaller,
    write: boolean,
    scope: string | undefined,
  ): Promise<Result<void, MindlogError>> {
    if (!caller.access) return ok(undefined);
    if (!this.#d.authorize) return err(mindlogError('PERMISSION_DENIED', 'authorization is off'));
    return this.#d.authorize(caller.access, write ? 'memory.write' : 'memory.read', {
      tenant: caller.tenant,
      ...(scope === undefined ? {} : { scope }),
    });
  }

  /** Whether a caller may read a scope, for paths that do not go through an operation. */
  authorizeRead(caller: MemoryCaller, user: string): Promise<Result<void, MindlogError>> {
    return this.#authorize(caller, false, user);
  }

  async #execute<N extends OpName>(
    caller: MemoryCaller,
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
    const allowed = await this.#authorize(caller, spec.write, input.scope.user);
    if (!allowed.ok) return allowed;
    if (this.#d.admit) {
      const admitted = await this.#d.admit(caller.tenant, admitClass(name));
      if (!admitted.ok) return admitted;
    }
    if (
      spec.write &&
      this.#d.clusterVersion &&
      this.#d.clusterVersion() <
        // An older binary would apply a branch write to main (ADR-0013).
        ((input as { branch?: string }).branch
          ? LOG_NATIVE_CLUSTER_VERSION
          : (spec.version ?? MEMORY_CLUSTER_VERSION))
    )
      return err(
        mindlogError(
          'UNAVAILABLE',
          `the cluster has not reached the version of ${name} commands yet; retry`,
        ),
      );
    const given = (input as { requestId?: string }).requestId;
    const requestId = spec.write
      ? given === undefined
        ? this.#requestId(caller)
        : clientRequestKey(caller, given)
      : undefined;
    const clusters = await this.#splits.clusters(caller.tenant, input.scope.user, () =>
      this.#runOn<{ clusters: number[] }>(
        caller,
        'layout',
        INTERNAL_OPS.layout,
        { scope: { user: input.scope.user } },
        undefined,
        0,
      ),
    );
    if (!clusters.ok) return clusters;
    if (clusters.value.length > 1)
      return this.#splits.run(name, input, clusters.value, (n, i, c) =>
        this.clusterCall(caller, n, i, c, requestId),
      ) as Promise<Result<OutputOf<N>, MindlogError>>;
    return this.#runOn(caller, name, spec, input, requestId, 0);
  }

  #requestId(caller: Caller): Uint8Array {
    return this.#d.stamper.stamp(caller.tenant, caller.principal, {
      case: 'memoryForget',
      value: { user: '', ids: [], reason: '' },
    }).requestId;
  }

  /**
   * Runs an operation, public or internal, on one cluster of a scope (ADR-0039).
   * The split worker and `ScopeSplits` use it; the caller was authorized already.
   */
  async clusterCall<T>(
    caller: MemoryCaller,
    name: string,
    raw: unknown,
    cluster: number,
    requestId?: Uint8Array,
  ): Promise<Result<T, MindlogError>> {
    const spec = (ALL_OPS as unknown as Record<string, Op<z.ZodType, T> | undefined>)[name];
    if (!spec) return err(mindlogError('INVALID_ARGUMENT', `unknown memory operation ${name}`));
    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success) return err(invalid(parsed.error.issues));
    const id = spec.write
      ? clusterRequestId(requestId ?? this.#requestId(caller), cluster)
      : undefined;
    return this.#runOn(caller, name, spec, parsed.data, id, cluster);
  }

  /** Drops this node's cached layout of a scope, after a split changed it. */
  layoutChanged(tenant: string, user: string): void {
    this.#splits.forget(tenant, user);
  }

  async #runOn<O>(
    caller: Caller,
    name: string,
    spec: Op<z.ZodType, O>,
    input: unknown,
    requestId: Uint8Array | undefined,
    cluster: number,
  ): Promise<Result<O, MindlogError>> {
    const { user } = (input as { scope: { user: string } }).scope;
    const key = scopeKey(caller.tenant, clusterUser(user, cluster));
    let placed = await this.#locate(key);
    for (let attempt = 0; ; attempt++) {
      if (!placed.ok) return placed;
      const result = await this.#once(placed.value, caller, name, spec, input, requestId, cluster);
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
    name: string,
    spec: Op<z.ZodType, O>,
    input: unknown,
    requestId: Uint8Array | undefined,
    cluster: number,
  ): Promise<Result<O, MindlogError>> {
    const call: RangeCall = {
      kind: 'memory',
      op: cluster > 0 ? `${name}#${String(cluster)}` : name,
      json: JSON.stringify(input),
      ...(requestId ? { requestId } : {}),
    };
    if (placement.local)
      return modelTenant.run(caller.tenant, () =>
        this.#local(placement.local as RangeTarget, caller, spec, input, requestId, cluster),
      );
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
    cluster = 0,
  ): Promise<Result<O, MindlogError>> {
    const given = (input as { scope: { user: string; agent?: string; session?: string } }).scope;
    // Below the service a cluster of a split scope is just another user (ADR-0039).
    const scope = { ...given, user: clusterUser(given.user, cluster) };
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
    const redact = spec.write && this.#d.redaction ? await this.#d.redaction(caller.tenant) : [];
    return spec.run(engines, range, { tenant: caller.tenant, ...scope }, input, {
      principal: caller.principal,
      ...(requestId ? { requestId } : {}),
      ...(redact.length > 0 ? { redact } : {}),
    });
  }

  /** Runs a memory call another node forwarded here (ADR-0016); the input is validated again. */
  async forwarded(rangeId: bigint, caller: Caller, call: RangeCall): Promise<KvReply> {
    if (call.kind !== 'memory') return replies.error('INVALID_ARGUMENT', 'not a memory call');
    const target = this.#d.router.local(rangeId);
    if (!target)
      return replies.error('RANGE_MOVED', `this node holds no replica of range ${String(rangeId)}`);
    const { name, cluster } = parseOp(call.op);
    const spec = (ALL_OPS as unknown as Record<string, Op<z.ZodType, unknown> | undefined>)[name];
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
    const result = await this.#local(target, caller, spec, parsed.data, call.requestId, cluster);
    return result.ok
      ? replies.bulk(encoder.encode(JSON.stringify(result.value ?? null)))
      : replies.error(result.error.code, result.error.message);
  }
}
