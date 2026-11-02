import type { KvReader } from '@mindlog/storage';
import type { Proposer } from '@mindlog/statemachine';
import type { PackGroup } from './recall/pack.js';
import type { RecipeName } from './recall/recipes.js';
import type { QueryRoute } from './recall/route.js';

export const MEMORY_KINDS = [
  'episodic',
  'semantic',
  'procedural',
  'working',
  'theme',
  'tool_trace',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const SOURCE_TYPES = [
  'user',
  'agent',
  'tool',
  'web',
  'document',
  'system',
  'consolidation',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type Trust = 'verified' | 'normal' | 'quarantined';

/** Where memory lives (PLAN 5.5); `user` is '' for tenant-wide memory. */
export interface MemoryScope {
  readonly tenant: string;
  readonly user: string;
  readonly agent?: string;
  readonly session?: string;
}

/** Who asks, and the request id that makes retries apply once (CLAUDE.md rule 5). */
export interface CallContext {
  readonly principal: string;
  readonly requestId?: Uint8Array;
}

/** One range as the engine uses it: propose to it, read its applied state. */
export interface MemoryRange {
  readonly rangeId: bigint;
  readonly proposer: Proposer;
  /** This range's applied state only (a `SpanReader`). */
  readonly reader: KvReader;
}

export interface RememberInput {
  readonly scope: MemoryScope;
  readonly content: string;
  /** Store the content as this kind, verbatim; without it facts are extracted. */
  readonly kind?: MemoryKind;
  readonly source?: { readonly type: SourceType; readonly ref?: string };
  /** Acknowledge after storing the raw text; enrich later in a job (PLAN 12.2). */
  readonly async?: boolean;
  readonly tags?: readonly string[];
  readonly meta?: Readonly<Record<string, unknown>>;
  /** World time (ms) the fact became true / stopped being true (ADR-0015). */
  readonly validFromMs?: number;
  readonly validToMs?: number;
  /** Write on this branch instead of main (ADR-0013). */
  readonly branch?: string;
  /** A tool call to remember as a procedural trace (PLAN 13.11); replaces `content`. */
  readonly toolTrace?: ToolTrace;
  /** Workers only: memories this one is derived from, and extra links (ADR-0033). */
  readonly derivedFrom?: readonly string[];
  readonly links?: readonly MemoryLinkView[];
}

/** A tool call an agent made (PLAN 13.11 tool traces). */
export interface ToolTrace {
  readonly tool: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly success: boolean;
}

/** A past state of the scope (PLAN 13.3): a log index of its range, or a time in ms. */
export type AsOf = { readonly index: bigint } | { readonly timeMs: number };

export interface MemoryLinkView {
  readonly to: string;
  readonly relation: string;
  readonly weight: number;
}

/** A memory as the interfaces show it. */
export interface MemoryView {
  readonly id: string;
  readonly user: string;
  readonly agent?: string;
  readonly session?: string;
  readonly kind: string;
  readonly text: string;
  readonly entities: readonly string[];
  readonly links: readonly MemoryLinkView[];
  readonly source: { readonly type: string; readonly ref?: string; readonly principal: string };
  readonly trust: string;
  readonly importance: number;
  readonly tags: readonly string[];
  /** Physical time of the commit (HLC), ms since the epoch. */
  readonly createdAtMs: number;
  /** Set once forgotten. */
  readonly expiredAtMs?: number;
  /** World-time validity window (ms), when known. */
  readonly validFromMs?: number;
  readonly validToMs?: number;
  readonly forgetReason?: string;
  /** Lifecycle (PLAN 13.7, ADR-0033): tier, pin, version, forgetting-curve strength and recalls. */
  readonly tier: 'hot' | 'cold';
  readonly pinned: boolean;
  readonly version: number;
  readonly strength: number;
  readonly recallCount: number;
  readonly lastRecalledAtMs?: number;
  /** Extra fields (evolution context, duplicate marks). */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface RememberOutput {
  readonly ids: readonly string[];
  readonly memories: readonly MemoryView[];
  /** The enrich job queued for an async or degraded remember. */
  readonly jobId?: string;
  /** True when model stages were skipped (PLAN 21). */
  readonly degraded: boolean;
}

export interface RecallInput {
  readonly scope: MemoryScope;
  readonly query: string;
  /** Results to return (default 10). */
  readonly k?: number;
  /** Token budget of the packed context (default 1000). */
  readonly tokenBudget?: number;
  /** Also match memories of the scope's ancestors (session → agent → user). */
  readonly inherit?: boolean;
  readonly kinds?: readonly MemoryKind[];
  readonly includeQuarantined?: boolean;
  /** Also return cold-tier memories, loaded from the blob store (PLAN 10.4; slower). */
  readonly includeCold?: boolean;
  /** Named recall configuration (ADR-0011); default `full`. */
  readonly recipe?: RecipeName;
  /** Also return each retriever's ranked ids and the route (PLAN 12.4 stage 11). */
  readonly explain?: boolean;
  /** Recall the scope as it was then (system time). */
  readonly asOf?: AsOf | undefined;
  /** Only facts true at this world time (ms); default: true at the ASOF time or now. */
  readonly validAtMs?: number;
  /** Recall the branch: its own memories over main as of its fork (ADR-0013). */
  readonly branch?: string;
}

/** Raw retriever scores (each on its own scale) and the normalised signals of the final score. */
export interface RecallSignals {
  readonly vector?: number;
  readonly keyword?: number;
  readonly entity?: number;
  readonly ppr?: number;
  readonly theme?: number;
  readonly rerank?: number;
  readonly fused: number;
  readonly recency: number;
  readonly importance: number;
  readonly retention: number;
}

export interface RecallItem {
  readonly memory: MemoryView;
  readonly score: number;
  /** Per-signal scores (PLAN 12.4 stage 11, explain). */
  readonly signals: RecallSignals;
}

/** A community of memories found for a broad query, named by its central entities. */
export interface RecallTheme {
  readonly label: string;
  readonly ids: readonly string[];
}

export interface RecallOutput {
  readonly items: readonly RecallItem[];
  /** The packed context to put in a prompt, grouped by kind (PLAN 13.6). */
  readonly context: string;
  readonly tokens: number;
  readonly budget: number;
  readonly groups: readonly PackGroup[];
  /** Candidates that did not fit the budget, best first. */
  readonly dropped: readonly string[];
  /** Candidates packed in a shortened form. */
  readonly compressed: readonly string[];
  readonly recipe: RecipeName;
  readonly route: QueryRoute;
  readonly degraded: boolean;
  /** With `explain`: ranked ids per retriever and the themes found. */
  readonly explain?: {
    readonly lists: Readonly<Record<string, readonly string[]>>;
    readonly themes: readonly RecallTheme[];
  };
}

export interface GraphView {
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly depth: number;
    readonly mentions: number;
  }>;
  readonly edges: ReadonlyArray<{
    readonly src: string;
    readonly relation: string;
    readonly dst: string;
    readonly weight: number;
  }>;
  /** Memories that mention the entity. */
  readonly memories: readonly string[];
  readonly truncated: boolean;
}

export interface HistoryEntry {
  /** MVCC version (HLC) of this state of the record; '' when only the kept copy remains. */
  readonly version: string;
  /** The record's version number (evolution, review). */
  readonly revision: number;
  readonly atMs: number;
  readonly memory: MemoryView;
}

/** A contradiction between an existing memory (a) and a newer one (b), as reviewers see it (ADR-0015). */
export interface ConflictView {
  readonly id: string;
  readonly a?: MemoryView;
  readonly b?: MemoryView;
  /** Contradiction probability of (a, b) and (b, a). */
  readonly scores: readonly [number, number];
  readonly status: 'open' | 'resolved';
  readonly policy: string;
  /** `ingest`, or `merge:<branch>`. */
  readonly origin: string;
  readonly detectedAtMs: number;
  readonly keep?: 'a' | 'b' | 'both';
  readonly resolvedBy?: string;
  readonly resolvedAtMs?: number;
}

export interface ResolveInput {
  readonly scope: MemoryScope;
  readonly id: string;
  readonly keep: 'a' | 'b' | 'both';
  /** With `both`: world time (ms) b replaced a. */
  readonly validFromMs?: number;
}

/** A memory branch as the interfaces show it (ADR-0013). */
export interface BranchView {
  readonly name: string;
  readonly status: 'open' | 'merged' | 'dropped';
  /** Log index and physical time of the fork. */
  readonly forkIndex: string;
  readonly forkAtMs: number;
  readonly createdBy: string;
  /** Memories written on the branch. */
  readonly writes: number;
  readonly closedAtMs?: number;
}

/** What a branch changed relative to main at its fork. */
export interface BranchDiff {
  readonly added: readonly MemoryView[];
  /** Main memories the branch forgot. */
  readonly forgotten: readonly MemoryView[];
  /** Main memories the branch changed otherwise (trust). */
  readonly changed: readonly MemoryView[];
}

export interface MergeResult {
  /** False when the `abort` policy found contradictions. */
  readonly merged: boolean;
  readonly added: readonly string[];
  readonly rejected: readonly string[];
  readonly conflicts: ReadonlyArray<{
    readonly a: string;
    readonly b: string;
    readonly scores: readonly [number, number];
    readonly resolved: boolean;
  }>;
}

/** A durable job as the dashboard shows it (PLAN 12.7, 17.2 Jobs page). */
export interface JobView {
  readonly id: string;
  readonly kind: string;
  readonly state: 'queued' | 'leased' | 'dead';
  readonly attempts: number;
  readonly deferrals: number;
  readonly runAtMs: number;
  readonly leaseUntilMs?: number;
  readonly error?: string;
  readonly createdAtMs: number;
  /** Why it was enqueued, for consolidation jobs. */
  readonly why?: string;
}

/** A scope's lifecycle state (ADR-0033). */
export interface LifecycleView {
  readonly hot: number;
  readonly cold: number;
  readonly writesSinceSleep: number;
  readonly writesSinceEvolve: number;
  readonly graphSize: number;
  readonly graphSizeAtTheme: number;
  readonly embedModel: string;
  readonly reembed: boolean;
  readonly lastWriteMs?: number;
  /** When each worker kind was last enqueued. */
  readonly lastRunMs: Readonly<Record<string, number>>;
  readonly tickAtMs?: number;
  readonly coldTier: boolean;
}
