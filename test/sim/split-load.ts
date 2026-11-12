import { searchBm25 } from '@mindlog/index-text';
import { MemoryReads, clusterUser, cluster, rankClusters, twoMeans } from '@mindlog/memory';
import type { ScopeCluster } from '@mindlog/proto';
import type { MemoryLoad } from './memory-load.js';
import type { World } from './world.js';

const TENANT = 'default';
const USER = 'split';
const PHYSICAL = [clusterUser(USER, 0), clusterUser(USER, 1)];
const SIDES = ['espresso grinder beans roast', 'orbit comet telescope galaxy'];
const BATCH = 8;
const enc = new TextEncoder();

export interface SplitLoadDeps {
  readonly world: World;
  readonly memory: MemoryLoad;
  readonly say: (line: string) => void;
  readonly violate: (what: string) => void;
}

/**
 * The semantic split workload (phase 10, ADR-0039): one scope gets memories
 * on two topics, is split in two by k-means, and has its memories moved to
 * the new cluster in batches (copy in, then mark moved) while writes and
 * forgets go on, under the run's faults. After healing and a last move pass,
 * every acknowledged memory is live in exactly one cluster (or forgotten),
 * and each cluster's BM25 statistics match what it holds.
 */
export class SplitLoad {
  readonly #d: SplitLoadDeps;
  #seq = 0;
  #layout: ScopeCluster[] | undefined;
  readonly acked = new Set<string>();
  readonly forgotten = new Set<string>();
  counts = { remembered: 0, moved: 0, forgotten: 0 };

  constructor(deps: SplitLoadDeps) {
    this.#d = deps;
  }

  /** A write: to the root before the split, then to the cluster nearest its text. */
  async remember(): Promise<void> {
    const seq = this.#seq++;
    const side = SIDES[seq % 2] ?? '';
    const content = `${side} note ${String(seq)}`;
    let target = 0;
    const layout = this.#layout;
    if (layout) {
      const routed = await this.#d.memory.run(USER, ({ engine }, range) =>
        engine.split.route(range, { tenant: TENANT, user: USER }, content, 'passage'),
      );
      target = routed.ok && !routed.value.degraded ? (routed.value.clusters[0] ?? 0) : 0;
    }
    const user = PHYSICAL[target] ?? USER;
    const requestId = enc.encode(`sim-split-${String(seq)}`);
    const done = await this.#d.memory.run(user, ({ engine }, range) =>
      engine.remember(
        range,
        { scope: { tenant: TENANT, user }, content, kind: 'semantic' },
        { principal: 'sim', requestId },
      ),
    );
    if (!done.ok) return;
    for (const id of done.value.ids) this.acked.add(id);
    this.counts.remembered++;
  }

  /** A forget sent to both clusters, as the service fans it out. */
  async forget(): Promise<void> {
    const live = [...this.acked].filter((id) => !this.forgotten.has(id));
    if (live.length === 0) return;
    const id = this.#d.world.pick(live);
    let answered = 0;
    for (const [n, user] of PHYSICAL.entries()) {
      const requestId = enc.encode(`sim-split-forget-${id}-${String(n)}`);
      const done = await this.#d.memory.run(user, ({ engine }, range) =>
        engine.forget(
          range,
          { scope: { tenant: TENANT, user }, ids: [id], reason: 'sim' },
          { principal: 'sim', requestId },
        ),
      );
      if (done.ok) answered++;
    }
    // Only a forget both clusters answered is known to have taken effect wherever the memory is.
    if (answered === PHYSICAL.length) {
      this.forgotten.add(id);
      this.counts.forgotten++;
    }
  }

  /** Splits the root in two by k-means over its vectors, once. */
  async split(): Promise<void> {
    if (this.#layout) return;
    const vectors = await this.#d.memory.run(USER, async ({ engine }, range) => ({
      ok: true as const,
      value: await engine.split.vectors(range, { tenant: TENANT, user: USER }, 10_000),
    }));
    if (!vectors.ok || vectors.value.length < 4) return;
    const result = twoMeans(
      vectors.value.map((v) => v.vector),
      42,
    );
    const layout = [
      cluster(0, result.centroids[0], result.spread[0]),
      cluster(1, result.centroids[1], result.spread[1]),
    ];
    const set = await this.#d.memory.run(USER, ({ engine }, range) =>
      engine.split.rehome(
        range,
        { tenant: TENANT, user: USER },
        { setLayout: true, layout },
        { principal: 'sim', requestId: enc.encode('sim-split-layout') },
      ),
    );
    if (!set.ok) return;
    this.#layout = layout;
    this.#d.say(`split: ${USER} split in two over ${String(vectors.value.length)} memories`);
  }

  /** One batch of root memories nearer cluster 1 moved there; false when none are left. */
  async move(): Promise<boolean> {
    const layout = this.#layout;
    if (!layout) return false;
    const root = { tenant: TENANT, user: USER };
    const picked = await this.#d.memory.run(USER, async ({ engine }, range) => {
      const vectors = await engine.split.vectors(range, root, 10_000);
      const ids = vectors
        .filter((v) => rankClusters(v.vector, layout)[0] === 1)
        .map((v) => v.id)
        .slice(0, BATCH);
      return { ok: true as const, value: await engine.split.copies(range, root, ids) };
    });
    if (!picked.ok || picked.value.length === 0) return false;
    const ids = picked.value.map((c) => c.record?.id ?? '');
    const key = ids.join(',');
    const target = PHYSICAL[1] ?? USER;
    const copied = await this.#d.memory.run(target, ({ engine }, range) =>
      engine.split.rehome(
        range,
        { tenant: TENANT, user: target },
        { copies: picked.value },
        { principal: 'sim', requestId: enc.encode(`sim-copy-${key}`) },
      ),
    );
    if (!copied.ok) return true;
    const marked = await this.#d.memory.run(USER, ({ engine }, range) =>
      engine.split.rehome(
        range,
        root,
        { moved: ids, movedTo: target },
        { principal: 'sim', requestId: enc.encode(`sim-mark-${key}`) },
      ),
    );
    if (!marked.ok) return true;
    this.counts.moved += marked.value.count;
    // Forgotten at the source between the copy and the mark: forget the copy as well.
    const kept = new Set(marked.value.ids);
    const lost = ids.filter((id) => !kept.has(id));
    if (lost.length > 0)
      await this.#d.memory.run(target, ({ engine }, range) =>
        engine.forget(
          range,
          {
            scope: { tenant: TENANT, user: target },
            ids: lost,
            reason: 'forgotten while it moved',
          },
          { principal: 'sim', requestId: enc.encode(`sim-lost-${key}`) },
        ),
      );
    return true;
  }

  /** After healing: finish the moves, then check where every memory is. */
  async settle(): Promise<boolean> {
    if (!this.#layout) return true;
    return !(await this.move());
  }

  async check(): Promise<void> {
    const where = new Map<string, string[]>();
    const expired = new Set<string>();
    for (const user of PHYSICAL) {
      const at = this.#d.memory.leader(user);
      if (!at) {
        this.#d.violate(`split: no leader for ${JSON.stringify(user)} after healing`);
        return;
      }
      const reads = new MemoryReads(at.range.reader, TENANT, user);
      const live: Array<{
        id: string;
        terms: Array<{ term: string; count: number }>;
        length: number;
      }> = [];
      for await (const r of reads.records()) {
        if (r.expiredAt === 0n) {
          live.push({ id: r.id, terms: r.terms, length: r.termLength });
          where.set(r.id, [...(where.get(r.id) ?? []), user]);
        } else expired.add(r.id);
      }
      const postings = reads.postings();
      const stats = await postings.stats();
      const total = live.reduce((n, r) => n + r.length, 0);
      if (stats.docs !== live.length || stats.totalLength !== total)
        this.#d.violate(
          `split: ${JSON.stringify(user)} stats ${JSON.stringify(stats)} for ${String(live.length)} live, length ${String(total)}`,
        );
      const df = new Map<string, number>();
      for (const r of live) for (const t of r.terms) df.set(t.term, (df.get(t.term) ?? 0) + 1);
      for (const [term, n] of df) {
        const stored = await postings.df(term);
        if (stored !== n)
          this.#d.violate(
            `split: ${JSON.stringify(user)} df(${term}) = ${String(stored)}, expected ${String(n)}`,
          );
      }
      const liveIds = new Set(live.map((r) => r.id));
      for (const h of await searchBm25(postings, ['espresso', 'orbit', 'note'], 1000))
        if (!liveIds.has(h.id))
          this.#d.violate(`split: ${JSON.stringify(user)} search returned ${h.id}, not live there`);
    }
    for (const id of this.acked) {
      const places = where.get(id) ?? [];
      if (places.length > 1)
        this.#d.violate(`split: ${id} is live in ${String(places.length)} clusters`);
      if (this.forgotten.has(id) && places.length > 0)
        this.#d.violate(`split: forgotten ${id} is still live`);
      if (!this.forgotten.has(id) && places.length === 0 && !expired.has(id))
        this.#d.violate(`split: acknowledged ${id} is in no cluster`);
    }
  }
}
