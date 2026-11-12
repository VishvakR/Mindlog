import type { AsOf } from '@mindlog/memory';
import {
  LIFECYCLE_JOBS,
  MEMORY_KINDS,
  MERGE_POLICIES,
  RECIPE_NAMES,
  SOURCE_TYPES,
  TRUST_LEVELS,
} from '@mindlog/memory';
import { z } from 'zod';

// Memory request schemas (PLAN 15), shared by RESP, REST, MCP and node-to-node forwarding.

// Control characters are reserved: collection job scopes start with one (ADR-0034).
const name = z
  .string()
  .max(128)
  .refine((s) => !Array.from(s).some((c) => c.charCodeAt(0) < 32), 'no control characters');

export const memoryScopeSchema = z.strictObject({
  /** '' is the tenant-wide scope. */
  user: name.default(''),
  agent: name.min(1).optional(),
  session: name.min(1).optional(),
});

const kind = z.enum(MEMORY_KINDS);

/** A memory branch (ADR-0013); `main` is the scope itself. */
const branchName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const onBranch = branchName
  .optional()
  .transform((b) => (b === 'main' ? undefined : b))
  .describe('Work on this branch instead of main');

/** A point in time: ms since the epoch, or an ISO 8601 date or date-time. */
const time = z
  .union([z.int().min(0), z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((t) => (typeof t === 'number' ? t : Date.parse(t)));

/**
 * `ASOF` (PLAN 13.3): a log index of the scope's range (a decimal string), or a
 * time. Parsed values stay JSON, since forwarded requests are parsed again.
 */
const asOf = z.union([
  z.strictObject({
    index: z.union([z.int().min(0), z.string().regex(/^\d{1,20}$/)]).transform(String),
  }),
  z.strictObject({ time }),
]);

/** The engine's form of a parsed `asOf`. */
export const toAsOf = (a: z.output<typeof asOf> | undefined): AsOf | undefined =>
  a === undefined ? undefined : 'index' in a ? { index: BigInt(a.index) } : { timeMs: a.time };

/** A tool call to keep as a procedural trace (PLAN 13.11); large parts are truncated. */
const toolTrace = z.strictObject({
  tool: z.string().min(1).max(128),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  success: z.boolean(),
});

/** A caller's id for a write: the same id applies once, so an offline queue can replay safely. */
const clientRequestId = z.string().min(1).max(128).optional();

export const rememberSchema = z.strictObject({
  scope: memoryScopeSchema,
  requestId: clientRequestId,
  /** Required unless `toolTrace` is given (the engine refuses empty content). */
  content: z
    .string()
    .max(64 * 1024)
    .default(''),
  toolTrace: toolTrace.optional(),
  kind: kind.optional(),
  source: z
    .strictObject({ type: z.enum(SOURCE_TYPES), ref: z.string().max(512).optional() })
    .optional(),
  async: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  /** World time the fact became true and stopped being true (ADR-0015). */
  validFrom: time.optional(),
  validTo: time.optional(),
  branch: onBranch,
});

export const recallSchema = z.strictObject({
  scope: memoryScopeSchema,
  query: z.string().min(1).max(4096),
  k: z.int().min(1).max(50).optional(),
  tokenBudget: z.int().min(1).max(32_000).optional(),
  inherit: z.boolean().optional(),
  kinds: z.array(kind).max(MEMORY_KINDS.length).optional(),
  includeQuarantined: z.boolean().optional(),
  /** Also return cold-tier memories (PLAN 10.4); slower. */
  includeCold: z.boolean().optional(),
  /** Named recall configuration (ADR-0011). */
  recipe: z.enum(RECIPE_NAMES).optional(),
  /** Also return each retriever's ranked ids and the themes found. */
  explain: z.boolean().optional(),
  /** Recall the scope as it was at a log index or time (system time). */
  asOf: asOf.optional(),
  /** Only facts true at this world time (default: at the ASOF time, or now). */
  validAt: time.optional(),
  branch: onBranch,
});

const memoryId = z.string().min(1).max(64);

export const getMemorySchema = z.strictObject({
  scope: memoryScopeSchema,
  id: memoryId,
  asOf: asOf.optional(),
  branch: onBranch,
});

export const listMemorySchema = z.strictObject({
  scope: memoryScopeSchema,
  limit: z.int().min(1).max(200).default(50),
  after: memoryId.optional(),
  kind: kind.optional(),
  includeForgotten: z.boolean().optional(),
  asOf: asOf.optional(),
  branch: onBranch,
});

export const forgetSchema = z
  .strictObject({
    scope: memoryScopeSchema,
    requestId: clientRequestId,
    ids: z.array(memoryId).max(100).default([]),
    reason: z.string().max(500).optional(),
    /** Taint cascade: forget everything from this source and derived from it (PLAN 13.4). */
    source: z.string().min(1).max(512).optional(),
    branch: onBranch,
  })
  .refine((f) => f.ids.length > 0 || f.source !== undefined, {
    message: 'give ids or a source',
    path: ['ids'],
  });

export const historySchema = z.strictObject({ scope: memoryScopeSchema, id: memoryId });

/** Several memories by id, for clients that follow the change stream (embedded replicas). */
export const getManySchema = z.strictObject({
  scope: memoryScopeSchema,
  ids: z.array(memoryId).min(1).max(100),
});

export const graphSchema = z.strictObject({
  scope: memoryScopeSchema,
  entity: z.string().min(1).max(256),
  depth: z.int().min(1).max(2).default(1),
});

export const cacheLookupSchema = z.strictObject({
  scope: memoryScopeSchema,
  prompt: z.string().min(1).max(4096),
  /** Similarity a hit needs, 0..1 (default 0.92). */
  threshold: z.number().min(0).max(1).optional(),
});

export const cacheStoreSchema = z.strictObject({
  scope: memoryScopeSchema,
  prompt: z.string().min(1).max(4096),
  answer: z
    .string()
    .min(1)
    .max(64 * 1024),
  /** Memories the answer was derived from; forgetting one drops the entry. */
  dependsOn: z.array(memoryId).max(100).optional(),
  ttlSeconds: z
    .int()
    .min(1)
    .max(30 * 86_400)
    .optional(),
  modelHint: z.string().max(128).optional(),
});

export const cacheDeleteSchema = z.strictObject({
  scope: memoryScopeSchema,
  ids: z.array(z.string().min(1).max(64)).min(1).max(100),
});

export const conflictsSchema = z.strictObject({
  scope: memoryScopeSchema,
  /** `open` (default) or every conflict. */
  status: z.enum(['open', 'all']).default('open'),
  limit: z.int().min(1).max(200).default(50),
  after: memoryId.optional(),
});

export const resolveSchema = z.strictObject({
  scope: memoryScopeSchema,
  id: memoryId,
  /** Which memory stays current: the existing one (a), the new one (b), or both. */
  keep: z.enum(['a', 'b', 'both']),
  /** With `both`: when b replaced a (world time). */
  validFrom: time.optional(),
});

export const trustSchema = z.strictObject({
  scope: memoryScopeSchema,
  ids: z.array(memoryId).min(1).max(100),
  trust: z.enum(TRUST_LEVELS as ['verified', 'normal', 'quarantined']),
  reason: z.string().max(500).optional(),
  branch: onBranch,
});

export const branchSchema = z.strictObject({ scope: memoryScopeSchema, name: branchName });

export const mergeSchema = z.strictObject({
  scope: memoryScopeSchema,
  name: branchName,
  /** What to do with branch facts that contradict main (ADR-0013). */
  policy: z.enum(MERGE_POLICIES).default('raise'),
});

export const branchesSchema = z.strictObject({ scope: memoryScopeSchema });

export const pinSchema = z.strictObject({
  scope: memoryScopeSchema,
  ids: z.array(memoryId).min(1).max(100),
  /** False unpins. */
  pinned: z.boolean().default(true),
});

/** Consolidation workers by short name (`sleep`, `dedup`, …). */
export const WORKER_NAMES: [string, ...string[]] = [
  // The semantic split (ADR-0039), only when named.
  'split',
  ...Object.values(LIFECYCLE_JOBS)
    .map((k) => k.replace('consolidation.', ''))
    .filter((k) => k !== 'tick'),
];

export const consolidateSchema = z.strictObject({
  scope: memoryScopeSchema,
  /** Workers to run now; default all of them. */
  workers: z.array(z.enum(WORKER_NAMES)).min(1).max(WORKER_NAMES.length).optional(),
});

export const jobsSchema = z.strictObject({
  scope: memoryScopeSchema,
  state: z.enum(['queued', 'leased', 'dead']).optional(),
  limit: z.int().min(1).max(200).default(50),
  after: z.string().min(1).max(128).optional(),
});

export const exportSchema = z.strictObject({ scope: memoryScopeSchema, asOf: asOf.optional() });

export const importSchema = z.strictObject({
  scope: memoryScopeSchema,
  format: z.enum(['mcube', 'cogx']).default('mcube'),
  /** The archive, base64 (at most 32 MB decoded). */
  data: z
    .string()
    .min(1)
    .max(44 * 1024 * 1024)
    .regex(/^[A-Za-z0-9+/=\s]+$/),
  /** Shown as the memories' source reference `import:<name>`. */
  name: z
    .string()
    .regex(/^[A-Za-z0-9._ -]{1,128}$/)
    .default('archive'),
});

export const scopesSchema = z.strictObject({ limit: z.int().min(1).max(1000).default(200) });

export type RememberRequest = z.input<typeof rememberSchema>;
export type RecallRequest = z.input<typeof recallSchema>;
export type GetMemoryRequest = z.input<typeof getMemorySchema>;
export type GetManyRequest = z.input<typeof getManySchema>;
export type ListMemoryRequest = z.input<typeof listMemorySchema>;
export type ForgetRequest = z.input<typeof forgetSchema>;
export type HistoryRequest = z.input<typeof historySchema>;
export type GraphRequest = z.input<typeof graphSchema>;
export type ConflictsRequest = z.input<typeof conflictsSchema>;
export type ResolveRequest = z.input<typeof resolveSchema>;
export type TrustRequest = z.input<typeof trustSchema>;
export type BranchRequest = z.input<typeof branchSchema>;
export type MergeRequest = z.input<typeof mergeSchema>;
export type BranchesRequest = z.input<typeof branchesSchema>;
export type ScopesRequest = z.input<typeof scopesSchema>;
export type PinRequest = z.input<typeof pinSchema>;
export type ConsolidateRequest = z.input<typeof consolidateSchema>;
export type JobsRequest = z.input<typeof jobsSchema>;
export type ExportRequest = z.input<typeof exportSchema>;
export type ImportRequest = z.input<typeof importSchema>;
export type CacheLookupRequest = z.input<typeof cacheLookupSchema>;
export type CacheStoreRequest = z.input<typeof cacheStoreSchema>;
export type CacheDeleteRequest = z.input<typeof cacheDeleteSchema>;
