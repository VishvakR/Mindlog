import type { Clock } from '@mindlog/core';
import { err, ok } from '@mindlog/core';
import { normalizeName } from '@mindlog/index-graph';
import { searchBm25, tokenize } from '@mindlog/index-text';
import type { Models } from '@mindlog/models-client';
import type { MemoryRecord } from '@mindlog/proto';
import type { Stage } from '../pipeline/stage.js';
import type { ScopeReads } from '../read/memory-reads.js';
import type { RecallItem, RecallSignals } from '../types.js';
import type { FlatIndex } from '@mindlog/index-vector';
import type { VectorMeta } from '../vector-cache.js';
import { toView } from '../view.js';
import { mmr, similarity } from './mmr.js';
import type { PprConfig, PprRunner } from './ppr.js';
import { minMax, pprStage } from './ppr.js';
import type { RecallDraft } from './recall-draft.js';
import { withList, withSignal } from './recall-draft.js';
import { rerankStage } from './rerank.js';
import { classifyQuery, routeWeights } from './route.js';
import { matchesScope } from './scope-filter.js';
import { finalScore, recency, retention, rrf } from './score.js';
import type { ThemeConfig } from './theme.js';
import { themeStage } from './theme.js';

export interface RecallConfig extends PprConfig, ThemeConfig {
  readonly entityLabels: readonly string[];
  /** Results per retriever (PLAN 12.4: 50). */
  readonly retrieveK: number;
  /** Candidates the cross-encoder scores (PLAN 12.4: 50). */
  readonly rerankK: number;
  readonly modelTimeoutMs: number;
}

/** The vector index recall searches: the scope's cached one, or one built for `ASOF` or a branch. */
export type IndexSource = () => Promise<FlatIndex<VectorMeta> | undefined>;

export interface RecallPorts {
  readonly models: Models;
  readonly index: IndexSource;
  readonly reads: ScopeReads;
  readonly clock: Clock;
  readonly ppr: PprRunner;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const byScore = (a: RecallItem, b: RecallItem) =>
  b.score - a.score || (a.memory.id < b.memory.id ? -1 : 1);

function parseStage(models: Models, config: RecallConfig): Stage<RecallDraft> {
  const timeoutMs = config.modelTimeoutMs;
  return {
    name: 'parse',
    needs: 'ner',
    timeoutMs,
    async run(d) {
      const r = await models.recognize([d.input.query], config.entityLabels, { timeoutMs });
      if (!r.ok) return err({ kind: 'skippable', error: r.error });
      const names = [...new Set((r.value.spans[0] ?? []).map((s) => normalizeName(s.text)))];
      // Any type with that name: the query's label may differ from the one stored.
      const ids = names.flatMap((n) => [...config.entityLabels, 'concept'].map((t) => `${t}:${n}`));
      return ok({ ...d, queryEntities: [...new Set(ids)], entityNames: names.length });
    },
    fallback: (d) => d,
  };
}

function vectorStage(
  models: Models,
  source: IndexSource,
  config: RecallConfig,
): Stage<RecallDraft> {
  const timeoutMs = config.modelTimeoutMs;
  return {
    name: 'vector',
    needs: 'embed',
    timeoutMs,
    async run(d) {
      const { scope, inherit = false, kinds, includeQuarantined = false } = d.input;
      const index = await source();
      if (!index || index.size === 0) return ok({ ...d, lists: withList(d, 'vector', []) });
      const r = await models.embed([d.input.query], 'query', { timeoutMs });
      if (!r.ok) return err({ kind: 'skippable', error: r.error });
      const q = r.value.vectors[0];
      if (!q || q.length !== index.dims) return ok({ ...d, lists: withList(d, 'vector', []) });
      const hits = index.search(
        q,
        config.retrieveK,
        (m) =>
          matchesScope(m, scope, inherit) &&
          (!kinds || kinds.includes(m.kind as never)) &&
          (includeQuarantined || m.trust !== 'quarantined'),
      );
      return ok({
        ...d,
        lists: withList(
          d,
          'vector',
          hits.map((h) => h.id),
        ),
        signals: withSignal(d.signals, hits, 'vector'),
      });
    },
    fallback: (d) => d,
  };
}

function lexicalStage(reads: ScopeReads, k: number): Stage<RecallDraft> {
  return {
    name: 'retrieve',
    async run(d) {
      const uses = d.recipe.retrievers;
      const [keyword, entity] = await Promise.all([
        uses.includes('keyword') ? searchBm25(reads.postings(), tokenize(d.input.query), k) : [],
        (async () => {
          if (!uses.includes('entity')) return [];
          const counts = new Map<string, number>();
          for (const e of d.queryEntities)
            for (const id of await reads.mentions(e, k)) counts.set(id, (counts.get(id) ?? 0) + 1);
          return [...counts]
            .map(([id, score]) => ({ id, score }))
            .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
            .slice(0, k);
        })(),
      ]);
      const lists = new Map(d.lists);
      if (uses.includes('keyword'))
        lists.set(
          'keyword',
          keyword.map((h) => h.id),
        );
      if (uses.includes('entity'))
        lists.set(
          'entity',
          entity.map((h) => h.id),
        );
      const signals = withSignal(withSignal(d.signals, keyword, 'keyword'), entity, 'entity');
      return ok({ ...d, lists, signals });
    },
  };
}

/** Whether a fact's world-time window `[validFrom, validTo)` holds at `t` ms (0 = open). */
export function validAt(r: { validFrom: bigint; validTo: bigint }, t: number): boolean {
  const at = BigInt(Math.floor(t));
  return r.validFrom <= at && (r.validTo === 0n || at < r.validTo);
}

function filterStage(reads: ScopeReads, clock: Clock, k: number): Stage<RecallDraft> {
  return {
    name: 'filter',
    async run(d) {
      const { scope, inherit = false, kinds, includeQuarantined = false } = d.input;
      // Facts true at VALID_AT, else at the ASOF time, else now (ADR-0015).
      const t = d.input.validAtMs ?? d.asOfMs ?? Number(clock.now());
      const ranked = [...d.fused]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 2 * k);
      const records: MemoryRecord[] = [];
      for (const [id] of ranked) {
        const r = await reads.record(id);
        if (!r || r.expiredAt !== 0n || !validAt(r, t)) continue;
        if (!includeQuarantined && r.trust === 'quarantined') continue;
        if (kinds && !kinds.includes(r.kind as never)) continue;
        if (!matchesScope(r, scope, inherit)) continue;
        records.push(r);
      }
      return ok({ ...d, records });
    },
  };
}

function scoreStage(clock: Clock): Stage<RecallDraft> {
  return {
    name: 'score',
    run(d) {
      const max = Math.max(1e-12, ...d.records.map((r) => d.fused.get(r.id) ?? 0));
      const reranked = new Map<string, number>();
      for (const r of d.records) {
        const s = d.signals.get(r.id)?.rerank;
        if (s !== undefined) reranked.set(r.id, s);
      }
      const rerank = reranked.size > 0 ? minMax(reranked) : undefined;
      const now = Number(clock.now());
      const ranked = d.records.map((r): RecallItem => {
        const last = Number((r.lastRecalledAt || r.createdAt) >> 16n);
        const fused = (d.fused.get(r.id) ?? 0) / max;
        const signals: RecallSignals = {
          ...d.signals.get(r.id),
          fused,
          recency: recency((now - last) / HOUR_MS),
          importance: r.importance,
          retention: retention((now - last) / DAY_MS, r.strength || 1),
        };
        const relevance = rerank?.get(r.id) ?? fused;
        const score = d.recipe.relevanceOnly
          ? relevance
          : finalScore({ ...signals, relevance, trust: r.trust });
        return { memory: toView(r), score, signals };
      });
      return Promise.resolve(ok({ ...d, ranked: ranked.sort(byScore) }));
    },
  };
}

function diversifyStage(source: IndexSource): Stage<RecallDraft> {
  return {
    name: 'diversify',
    async run(d) {
      const index = await source();
      // Min-max scores, so relevance spans 0..1 like the similarity it is traded against:
      // the recency/importance/retention floor would otherwise let near-duplicates lose to noise.
      const scaled = minMax(new Map(d.ranked.map((item) => [item.memory.id, item.score])));
      const candidates = d.ranked.map((item) => ({
        id: item.memory.id,
        text: item.memory.text,
        score: scaled.get(item.memory.id) ?? 0,
        item,
      }));
      const sim = similarity((id) => index?.get(id));
      return ok({ ...d, ranked: mmr(candidates, sim).map((c) => c.item) });
    },
  };
}

/**
 * The recall stages of a recipe (PLAN 12.4 stages 1, 3–8, ADR-0011): parse,
 * route, the recipe's retrievers, weighted RRF, filter, optional rerank,
 * score and optional MMR. Packing is the engine's.
 */
export function recallStages(
  ports: RecallPorts,
  config: RecallConfig,
  d: RecallDraft,
): Stage<RecallDraft>[] {
  const { models, index, reads, clock } = ports;
  const uses = new Set(d.recipe.retrievers);
  const k = config.retrieveK;
  const stages: Stage<RecallDraft>[] = [];
  if (uses.has('entity') || uses.has('ppr') || uses.has('theme'))
    stages.push(parseStage(models, config));
  stages.push({
    name: 'route',
    run: (x) => Promise.resolve(ok({ ...x, route: classifyQuery(x.input.query, x.entityNames) })),
  });
  if (uses.has('vector')) stages.push(vectorStage(models, index, config));
  if (uses.has('keyword') || uses.has('entity')) stages.push(lexicalStage(reads, k));
  if (uses.has('ppr')) stages.push(pprStage(reads, ports.ppr, config));
  if (uses.has('theme')) stages.push(themeStage(reads, config));
  stages.push(
    {
      name: 'fuse',
      run: (x) => Promise.resolve(ok({ ...x, fused: rrf(x.lists, routeWeights(x.route)) })),
    },
    filterStage(reads, clock, k),
  );
  if (d.recipe.rerank) stages.push(rerankStage(models, config));
  stages.push(scoreStage(clock));
  if (d.recipe.mmr) stages.push(diversifyStage(index));
  return stages;
}
