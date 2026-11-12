import { toBinary } from '@bufbuild/protobuf';
import type { Clock, Counter, Logger, Metrics, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { LeasedJob, Worker, WorkerOutcome } from '@mindlog/jobs';
import type { KmeansRunner, MemoryEngine, MemoryRange } from '@mindlog/memory';
import {
  MAX_CLUSTERS,
  SPLIT_JOB,
  baseUser,
  bytesOf,
  clusterIdOf,
  clusterUser,
  distance,
  normalise,
  rankClusters,
  vectorOf,
} from '@mindlog/memory';
import { NewMemorySchema, ScopeClusterSchema } from '@mindlog/proto';
import { create } from '@bufbuild/protobuf';
import type { MemoryService } from './memory-service.js';

export interface SplitConfig {
  /** A scope or cluster splits once it holds this many hot memories. */
  readonly maxMemories: number;
  /** Drift: a cluster is re-centred when its spread grows past this multiple (PLAN 8.5: 1.5). */
  readonly driftRatio: number;
}

export interface SplitWorkerDeps {
  readonly memory: MemoryService;
  readonly engine: MemoryEngine;
  readonly ranges: (rangeId: bigint) => MemoryRange | undefined;
  readonly kmeans: KmeansRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly config: SplitConfig;
}

interface Layout {
  readonly id: number;
  readonly centroid: string;
  readonly spread: number;
}

/** Memories moved per batch, and per run before the job yields. */
const BATCH = 64;
const MOVES_PER_RUN = 2_048;
/** Only move a memory that is clearly nearer another cluster, so boundary memories do not flap. */
const MARGIN = 0.02;
const MAX_VECTORS = 200_000;

const seedOf = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const toLayout = (id: number, centroid: Float32Array, spread: number): Layout => ({
  id,
  centroid: Buffer.from(bytesOf(centroid)).toString('base64'),
  spread,
});
const protoOf = (l: Layout) =>
  create(ScopeClusterSchema, {
    id: l.id,
    centroid: new Uint8Array(Buffer.from(l.centroid, 'base64')),
    spread: l.spread,
  });

/**
 * The semantic split worker (PLAN 8.5, ADR-0039), on one cluster of a scope:
 * splits it in two by k-means once it is too big, re-centres it when it has
 * drifted, and moves memories that are nearer another cluster there, in
 * idempotent batches (copy in, then mark moved). It runs on the cluster's
 * leader, so its reads are local; the moves go through the service, which
 * reaches any range.
 */
export function splitWorker(d: SplitWorkerDeps): Worker {
  const counted = {
    moved: d.metrics.counter({
      name: 'mindlog_memory_split_moved_total',
      help: 'Memories a semantic split moved to another cluster',
    }),
    bytes: d.metrics.counter({
      name: 'mindlog_memory_split_moved_bytes_total',
      help: 'Encoded bytes of the memories a semantic split moved',
    }),
    splits: d.metrics.counter({
      name: 'mindlog_memory_splits_total',
      help: 'Clusters semantic splits created',
    }),
  };
  return {
    kind: SPLIT_JOB,
    run: (job) => runSplit({ ...d, counted }, job),
  };
}

type Counted = SplitWorkerDeps & {
  readonly counted: { moved: Counter; bytes: Counter; splits: Counter };
};

async function runSplit(d: Counted, job: LeasedJob): Promise<Result<WorkerOutcome, MindlogError>> {
  const range = d.ranges(job.rangeId);
  if (!range) return err(mindlogError('UNAVAILABLE', `range ${String(job.rangeId)} is not here`));
  const base = baseUser(job.user);
  const me = clusterIdOf(job.user);
  const caller = { tenant: job.tenant, principal: 'system:split' };
  const scope = { user: base };
  const read = await d.memory.clusterCall<{ clusters: Layout[] }>(caller, 'clusters', { scope }, 0);
  if (!read.ok) return read;
  let layout = read.value.clusters;
  const physical = { tenant: job.tenant, user: job.user };
  const vectors = await d.engine.split.vectors(range, physical, MAX_VECTORS);
  if (vectors.length === 0) return ok({ completed: false });
  const mine = layout.find((c) => c.id === me);
  const tooBig = vectors.length >= d.config.maxMemories && layout.length < MAX_CLUSTERS;
  const setLayout = async (next: Layout[]) => {
    const written = await d.memory.clusterCall(
      caller,
      'rehome',
      { scope, setLayout: true, layout: next },
      0,
    );
    d.memory.layoutChanged(job.tenant, base);
    return written;
  };
  if (tooBig) {
    const split = await d.kmeans(
      vectors.map((v) => v.vector),
      seedOf(`${job.tenant}/${job.user}`),
    );
    const next = Math.max(0, ...layout.map((c) => c.id)) + 1;
    const updated = [
      ...layout.filter((c) => c.id !== me),
      toLayout(me, split.centroids[0], split.spread[0]),
      toLayout(next, split.centroids[1], split.spread[1]),
    ].sort((a, b) => a.id - b.id);
    const written = await setLayout(updated);
    if (!written.ok) return written;
    layout = updated;
    d.counted.splits.inc();
    d.logger.info('memory scope split', {
      tenant: job.tenant,
      user: base,
      from: me,
      to: next,
      memories: vectors.length,
    });
  } else if (mine) {
    const centroid = vectorOf(new Uint8Array(Buffer.from(mine.centroid, 'base64')));
    const spread = vectors.reduce((s, v) => s + distance(v.vector, centroid), 0) / vectors.length;
    if (mine.spread > 0 && spread > mine.spread * d.config.driftRatio) {
      // Drifted: centre the cluster on what it holds now, then let the moves below rebalance.
      const sum = new Float32Array(centroid.length);
      for (const v of vectors)
        for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] ?? 0) + (v.vector[i] ?? 0);
      const moved = normalise(sum);
      const updated = layout.map((c) =>
        c.id === me
          ? toLayout(
              me,
              moved,
              vectors.reduce((s, v) => s + distance(v.vector, moved), 0) / vectors.length,
            )
          : c,
      );
      const written = await setLayout(updated);
      if (!written.ok) return written;
      layout = updated;
    }
  }
  if (layout.length < 2) return ok({ completed: false });
  return moveAway(d, job, range, layout, vectors, caller);
}

async function moveAway(
  d: Counted,
  job: LeasedJob,
  range: MemoryRange,
  layout: readonly Layout[],
  vectors: ReadonlyArray<{ id: string; vector: Float32Array }>,
  caller: { tenant: string; principal: string },
): Promise<Result<WorkerOutcome, MindlogError>> {
  const me = clusterIdOf(job.user);
  const base = baseUser(job.user);
  const clusters = layout.map(protoOf);
  const centroidOf = new Map(clusters.map((c) => [c.id, vectorOf(c.centroid)]));
  const own = centroidOf.get(me);
  const targets = new Map<number, string[]>();
  for (const { id, vector } of vectors) {
    const best = rankClusters(vector, clusters)[0];
    if (best === undefined || best === me) continue;
    const there = centroidOf.get(best);
    if (own && there && distance(vector, own) - distance(vector, there) < MARGIN) continue;
    targets.set(best, [...(targets.get(best) ?? []), id]);
  }
  let moves = 0;
  for (const [target, ids] of targets) {
    for (let at = 0; at < ids.length; at += BATCH) {
      if (moves >= MOVES_PER_RUN)
        return ok({ completed: false, deferUntilMs: d.clock.now() + 1_000n });
      const batch = ids.slice(at, at + BATCH);
      const copies = await d.engine.split.copies(
        range,
        { tenant: job.tenant, user: job.user },
        batch,
      );
      const scope = { user: base };
      const encoded = copies.map((c) => toBinary(NewMemorySchema, c));
      const copied = await d.memory.clusterCall(
        caller,
        'rehome',
        { scope, copies: encoded.map((b) => Buffer.from(b).toString('base64')) },
        target,
      );
      if (!copied.ok) return copied;
      // Marked only once the copy is durable: a crash in between copies again, harmlessly.
      const marked = await d.memory.clusterCall<{ ids: string[] }>(
        caller,
        'rehome',
        { scope, moved: copies.map((c) => c.record?.id ?? ''), movedTo: clusterUser(base, target) },
        me,
      );
      if (!marked.ok) return marked;
      // Forgotten at the source between the copy and the mark: forget the copy as well.
      const kept = new Set(marked.value.ids);
      const lost = copies.map((c) => c.record?.id ?? '').filter((id) => id !== '' && !kept.has(id));
      if (lost.length > 0) {
        const forgot = await d.memory.clusterCall(
          caller,
          'forget',
          { scope, ids: lost, reason: 'forgotten while it moved' },
          target,
        );
        if (!forgot.ok) return forgot;
      }
      moves += batch.length;
      d.counted.moved.inc(copies.length);
      d.counted.bytes.inc(encoded.reduce((n, b) => n + b.length, 0));
    }
  }
  if (moves > 0)
    d.logger.info('memory split moved memories', {
      tenant: job.tenant,
      user: base,
      from: me,
      moves,
    });
  // A cluster that took memories may be over the threshold itself; it checks on its own leader.
  for (const target of targets.keys())
    await d.memory.clusterCall(
      caller,
      'consolidate',
      { scope: { user: base }, workers: ['split'] },
      target,
    );
  // Still too big after giving half away: split again (up to the cluster limit).
  const left = vectors.length - moves;
  if (left >= d.config.maxMemories && layout.length < MAX_CLUSTERS)
    return ok({ completed: false, deferUntilMs: d.clock.now() + 1_000n });
  return ok({ completed: false });
}
