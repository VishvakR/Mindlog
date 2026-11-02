import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { AddedFact, ChangedRecord, EdgeChange, Fields, MergePolicy } from '@mindlog/branching';
import { planMerge } from '@mindlog/branching';
import { fromBinary } from '@bufbuild/protobuf';
import type { Models } from '@mindlog/models-client';
import type { BranchMerge, MemoryBranch, MemoryRecord } from '@mindlog/proto';
import { MemoryVectorSchema } from '@mindlog/proto';
import { MvccReader } from '@mindlog/storage';
import { checkFacts } from './ingest/conflict-stage.js';
import type { ConflictConfig } from './ingest/conflicts.js';
import type { DraftFact } from './ingest/draft.js';
import type { Root } from './keys.js';
import { vectorKey } from './keys.js';
import { MemoryReads } from './read/memory-reads.js';
import { OverlayReads } from './read/overlay-reads.js';
import type { IndexSource } from './recall/recall-stages.js';
import type {
  BranchDiff,
  BranchView,
  MemoryKind,
  MemoryRange,
  MemoryScope,
  MergeResult,
  Trust,
} from './types.js';
import type { VectorCache } from './vector-cache.js';
import { decodeVector } from './vector-cache.js';
import { hlcMs, toView } from './view.js';

// Reading branches and planning their merges on the leader (ADR-0013).

/** Supporting memories an edge keeps; the same cap as `writeEdge`. */
const EDGE_SUPPORT = 20;

export function branchView(b: MemoryBranch): BranchView {
  return {
    name: b.name,
    status: b.status as BranchView['status'],
    forkIndex: String(b.forkIndex),
    forkAtMs: hlcMs(b.forkVersion),
    createdBy: b.createdBy,
    writes: b.writes,
    ...(b.closedAt !== 0n ? { closedAtMs: hlcMs(b.closedAt) } : {}),
  };
}

/** The open branch `name` of a scope, or NOT_FOUND. */
export async function openBranch(
  range: MemoryRange,
  scope: MemoryScope,
  name: string,
): Promise<Result<MemoryBranch, MindlogError>> {
  const b = await new MemoryReads(range.reader, scope.tenant, scope.user).branch(name);
  return b?.status === 'open' ? ok(b) : err(mindlogError('NOT_FOUND', `no open branch ${name}`));
}

/** Recall's view of a branch: its space over main at the fork, and a vector index of both. */
export function branchSources(
  range: MemoryRange,
  scope: MemoryScope,
  branch: MemoryBranch,
  vectors: VectorCache,
): { reads: OverlayReads; index: IndexSource } {
  const root: Root = { user: scope.user, branch: branch.name };
  const main = new MemoryReads(range.reader, scope.tenant, scope.user, branch.forkVersion);
  const reads = new OverlayReads(new MemoryReads(range.reader, scope.tenant, root), main);
  let built: ReturnType<IndexSource> | undefined;
  const index: IndexSource = () =>
    (built ??= vectors.indexOf(scope.tenant, [
      { root: scope.user, at: branch.forkVersion },
      { root },
    ]));
  return { reads, index };
}

/** Adds, forgets and other changes of a branch relative to main at its fork. */
export async function diffBranch(
  range: MemoryRange,
  scope: MemoryScope,
  branch: MemoryBranch,
): Promise<BranchDiff> {
  const own = new MemoryReads(range.reader, scope.tenant, {
    user: scope.user,
    branch: branch.name,
  });
  const fork = new MemoryReads(range.reader, scope.tenant, scope.user, branch.forkVersion);
  const added = [];
  const forgotten = [];
  const changed = [];
  for await (const r of own.records()) {
    const atFork = await fork.record(r.id);
    if (!atFork) {
      if (r.expiredAt === 0n) added.push(toView(r));
    } else if (r.expiredAt !== 0n) forgotten.push(toView(r));
    else changed.push(toView(r));
  }
  return { added, forgotten, changed };
}

const fields = (r: MemoryRecord): Fields => ({
  expired: r.expiredAt !== 0n,
  trust: r.trust,
  validTo: r.validTo,
});

async function draftOf(reads: MemoryReads, mvcc: MvccReader, r: MemoryRecord): Promise<DraftFact> {
  const row = await mvcc.get(vectorKey(reads.tenant, reads.user, r.id));
  const mentions = [];
  for (const id of r.entities) {
    const e = await reads.entity(id);
    if (e) mentions.push({ name: e.name, type: e.type });
  }
  return {
    text: r.text,
    kind: r.kind as MemoryKind,
    relations: [],
    mentions,
    ...(row ? { vector: decodeVector(fromBinary(MemoryVectorSchema, row)) } : {}),
    importance: r.importance,
    links: [],
    trust: r.trust as Trust,
  };
}

export interface MergeDeps {
  readonly models: Models;
  readonly vectors: VectorCache;
  readonly config: ConflictConfig & { readonly modelTimeoutMs: number };
  readonly ids: { next(): string };
  readonly nowMs: number;
  readonly principal: string;
  /** Fence the plan on the branch's generation too (cluster version 8, ADR-0033). */
  readonly fenceBranch?: boolean;
}

/**
 * Plans the merge of an open branch (ADR-0013): reads what the branch changed,
 * checks its new facts against main's current ones with NLI, and asks the
 * planner. Returns the `BranchMerge` body to propose, or the result of an
 * aborted merge.
 */
export async function planBranchMerge(
  range: MemoryRange,
  scope: MemoryScope,
  branch: MemoryBranch,
  policy: MergePolicy,
  deps: MergeDeps,
): Promise<Result<{ body?: Omit<BranchMerge, '$typeName'>; result: MergeResult }, MindlogError>> {
  const { tenant, user } = scope;
  const main = new MemoryReads(range.reader, tenant, user);
  const fork = new MemoryReads(range.reader, tenant, user, branch.forkVersion);
  const own = new MemoryReads(range.reader, tenant, { user, branch: branch.name });
  const mvcc = new MvccReader(range.reader);
  const generation = await main.generation();
  const branchGeneration = deps.fenceBranch ? await own.generation() : 0;
  const records: ChangedRecord[] = [];
  const added: MemoryRecord[] = [];
  for await (const r of own.records()) {
    if (await fork.record(r.id)) {
      const now = await main.recordVersion(r.id);
      const mine = await own.recordVersion(r.id);
      const atFork = await fork.record(r.id);
      if (now && mine && atFork)
        records.push({
          id: r.id,
          fork: fields(atFork),
          main: fields(now.record),
          mainHlc: now.version,
          branch: fields(r),
          branchHlc: mine.version,
        });
    } else if (r.expiredAt === 0n) added.push(r);
  }
  const facts = await Promise.all(added.map((r) => draftOf(own, mvcc, r)));
  const checked = await checkFacts(
    {
      scope,
      windows: added.map((r) => ({ validFrom: Number(r.validFrom), validTo: Number(r.validTo) })),
      facts,
      nowMs: deps.nowMs,
      minSimilarity: deps.config.conflictMinSimilarity,
    },
    { nli: deps.models, reads: main, vectors: deps.vectors },
    // Raw contradictions: the merge policy decides what they do.
    { ...deps.config, conflictPolicy: 'ask_human' },
    { timeoutMs: deps.config.modelTimeoutMs },
  );
  if (!checked.ok)
    return err(
      mindlogError('UNAVAILABLE', `merging checks conflicts with NLI: ${checked.error.message}`),
    );
  const adds: AddedFact[] = added.map((r, i) => ({
    id: r.id,
    contradicts: (checked.value[i]?.conflicts ?? []).map((c) => ({
      with: c.with,
      scoreAB: c.scoreAB,
      scoreBA: c.scoreBA,
    })),
  }));
  const edges: EdgeChange[] = [];
  for await (const e of own.edges()) {
    const m = await main.edge(e.src, e.relation, e.dst);
    edges.push({
      key: [e.src, e.relation, e.dst].join('\u0000'),
      main: { weight: m?.weight ?? 0, memories: m?.memories ?? [] },
      branch: { weight: e.edge.weight, memories: e.edge.memories },
    });
  }
  const plan = planMerge({
    branch: branch.name,
    policy,
    adds,
    records,
    edges,
    edgeSupport: EDGE_SUPPORT,
  });
  const result: MergeResult = {
    merged: !plan.aborted,
    added: plan.adds.map((a) => a.id),
    rejected: [...plan.rejected],
    conflicts: plan.conflicts.map((c) => ({
      a: c.a,
      b: c.b,
      scores: [c.scoreAB, c.scoreBA] as const,
      resolved: c.resolved,
    })),
  };
  if (plan.aborted) return ok({ result });
  const temporal = checked.value.flatMap((c) => c.supersede);
  const body: Omit<BranchMerge, '$typeName'> = {
    user,
    name: branch.name,
    policy,
    mainGeneration: BigInt(generation),
    branchGeneration: BigInt(branchGeneration),
    adds: plan.adds.map((a) => ({ $typeName: 'mindlog.v1.BranchAdd', ...a })),
    records: plan.records.map((r) => ({
      $typeName: 'mindlog.v1.RecordFields',
      id: r.id,
      ...r.fields,
    })),
    edges: plan.edges.map((e) => {
      const [src = '', relation = '', dst = ''] = e.key.split('\u0000');
      return {
        $typeName: 'mindlog.v1.EdgeWeight',
        src,
        relation,
        dst,
        weight: e.weight,
        memories: [...e.memories],
      };
    }),
    conflicts: plan.conflicts.map((c) => ({
      $typeName: 'mindlog.v1.MemoryConflict',
      id: deps.ids.next(),
      a: c.a,
      b: c.b,
      scoreAb: c.scoreAB,
      scoreBa: c.scoreBA,
      detectedAt: 0n,
      status: c.resolved ? 'resolved' : 'open',
      policy,
      origin: `merge:${branch.name}`,
      modelId: '',
      keep: c.resolved ? 'b' : '',
      resolvedBy: c.resolved ? deps.principal : '',
      resolvedAt: 0n,
    })),
    supersede: [
      ...plan.supersede.map((id) => ({
        $typeName: 'mindlog.v1.Supersede' as const,
        id,
        validTo: BigInt(deps.nowMs),
      })),
      ...temporal.map((s) => ({
        $typeName: 'mindlog.v1.Supersede' as const,
        id: s.id,
        validTo: BigInt(s.validTo),
      })),
    ],
    rejected: [...plan.rejected],
  };
  return ok({ body, result });
}
