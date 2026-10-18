import type { Clock } from '@mindlog/core';
import { err, ok } from '@mindlog/core';
import { normalizeName } from '@mindlog/index-graph';
import { searchBm25, tokenize } from '@mindlog/index-text';
import type { Models } from '@mindlog/models-client';
import type { MemoryRecord } from '@mindlog/proto';
import type { Stage } from '../pipeline/stage.js';
import type { MemoryReads } from '../read/memory-reads.js';
import type { RecallInput, RecallItem, RecallSignals } from '../types.js';
import type { VectorCache } from '../vector-cache.js';
import { toView } from '../view.js';
import { matchesScope } from './scope-filter.js';
import { finalScore, recency, retention, rrf } from './score.js';

type Signals = { vector?: number; keyword?: number; entity?: number };

/** What the recall stages fill in, in order (PLAN 12.4). */
export interface RecallDraft {
  readonly input: RecallInput;
  /** Candidate entity ids of the query's entities. */
  readonly queryEntities: readonly string[];
  /** Ranked ids per retriever. */
  readonly lists: ReadonlyMap<string, readonly string[]>;
  readonly signals: ReadonlyMap<string, Signals>;
  readonly records: readonly MemoryRecord[];
  readonly fused: ReadonlyMap<string, number>;
  readonly items: readonly RecallItem[];
}

export interface RecallConfig {
  readonly entityLabels: readonly string[];
  /** Results per retriever (PLAN 12.4: 50). */
  readonly retrieveK: number;
  readonly modelTimeoutMs: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function withSignal(
  signals: ReadonlyMap<string, Signals>,
  hits: ReadonlyArray<{ id: string; score: number }>,
  signal: keyof Signals,
): Map<string, Signals> {
  const out = new Map(signals);
  for (const h of hits) out.set(h.id, { ...out.get(h.id), [signal]: h.score });
  return out;
}

function withList(d: RecallDraft, name: string, ids: string[]): Map<string, readonly string[]> {
  return new Map([...d.lists, [name, ids]]);
}

/** Recall stages 1, 3 (vector, keyword, entity), 4, 5, 7 (PLAN 12.4); packing is the engine's. */
export function recallStages(
  models: Models,
  vectors: VectorCache,
  reads: MemoryReads,
  clock: Clock,
  config: RecallConfig,
): Stage<RecallDraft>[] {
  const timeoutMs = config.modelTimeoutMs;
  const k = config.retrieveK;
  return [
    {
      name: 'parse',
      needs: 'ner',
      timeoutMs,
      async run(d) {
        const r = await models.recognize([d.input.query], config.entityLabels, { timeoutMs });
        if (!r.ok) return err({ kind: 'skippable', error: r.error });
        const names = (r.value.spans[0] ?? []).map((s) => normalizeName(s.text));
        // Any type with that name: the query's label may differ from the one stored.
        const ids = names.flatMap((n) =>
          [...config.entityLabels, 'concept'].map((t) => `${t}:${n}`),
        );
        return ok({ ...d, queryEntities: [...new Set(ids)] });
      },
      fallback: (d) => d,
    },
    {
      name: 'vector',
      needs: 'embed',
      timeoutMs,
      async run(d) {
        const { scope, inherit = false, kinds, includeQuarantined = false } = d.input;
        const index = await vectors.index(scope.tenant, scope.user);
        if (!index || index.size === 0) return ok({ ...d, lists: withList(d, 'vector', []) });
        const r = await models.embed([d.input.query], 'query', { timeoutMs });
        if (!r.ok) return err({ kind: 'skippable', error: r.error });
        const q = r.value.vectors[0];
        if (!q || q.length !== index.dims) return ok({ ...d, lists: withList(d, 'vector', []) });
        const hits = index.search(
          q,
          k,
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
    },
    {
      name: 'retrieve',
      async run(d) {
        const [keyword, entity] = await Promise.all([
          searchBm25(reads.postings(), tokenize(d.input.query), k),
          (async () => {
            const counts = new Map<string, number>();
            for (const e of d.queryEntities)
              for (const id of await reads.mentions(e, k))
                counts.set(id, (counts.get(id) ?? 0) + 1);
            return [...counts]
              .map(([id, score]) => ({ id, score }))
              .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
              .slice(0, k);
          })(),
        ]);
        const lists = new Map([
          ...d.lists,
          ['keyword', keyword.map((h) => h.id)],
          ['entity', entity.map((h) => h.id)],
        ]);
        const signals = withSignal(withSignal(d.signals, keyword, 'keyword'), entity, 'entity');
        return ok({ ...d, lists, signals });
      },
    },
    { name: 'fuse', run: (d) => Promise.resolve(ok({ ...d, fused: rrf(d.lists, {}) })) },
    {
      name: 'filter',
      async run(d) {
        const { scope, inherit = false, kinds, includeQuarantined = false } = d.input;
        const ranked = [...d.fused]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .slice(0, 2 * k);
        const records: MemoryRecord[] = [];
        for (const [id] of ranked) {
          const r = await reads.record(id);
          if (!r || r.expiredAt !== 0n) continue;
          if (!includeQuarantined && r.trust === 'quarantined') continue;
          if (kinds && !kinds.includes(r.kind as never)) continue;
          if (!matchesScope(r, scope, inherit)) continue;
          records.push(r);
        }
        return ok({ ...d, records });
      },
    },
    {
      name: 'score',
      run(d) {
        const max = Math.max(1e-12, ...d.records.map((r) => d.fused.get(r.id) ?? 0));
        const now = Number(clock.now());
        const items = d.records.map((r): RecallItem => {
          const last = Number((r.lastRecalledAt || r.createdAt) >> 16n);
          const signals: RecallSignals = {
            ...d.signals.get(r.id),
            fused: (d.fused.get(r.id) ?? 0) / max,
            recency: recency((now - last) / HOUR_MS),
            importance: r.importance,
            retention: retention((now - last) / DAY_MS, r.strength || 1),
          };
          const score = finalScore({ relevance: signals.fused, ...signals, trust: r.trust });
          return { memory: toView(r), score, signals };
        });
        items.sort((a, b) => b.score - a.score || (a.memory.id < b.memory.id ? -1 : 1));
        return Promise.resolve(ok({ ...d, items: items.slice(0, d.input.k ?? 10) }));
      },
    },
  ];
}
