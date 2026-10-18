import type { KvReader } from '@mindlog/storage';
import type { Proposer } from '@mindlog/statemachine';

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
}

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
  readonly forgetReason?: string;
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
}

export interface RecallSignals {
  readonly vector?: number;
  readonly keyword?: number;
  readonly entity?: number;
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

export interface RecallOutput {
  readonly items: readonly RecallItem[];
  /** The packed context to put in a prompt. */
  readonly context: string;
  readonly tokens: number;
  readonly degraded: boolean;
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
  /** MVCC version (HLC) of this state of the record. */
  readonly version: string;
  readonly atMs: number;
  readonly memory: MemoryView;
}
