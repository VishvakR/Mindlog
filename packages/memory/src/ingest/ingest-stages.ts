import { err, mindlogError, ok } from '@mindlog/core';
import type { Models } from '@mindlog/models-client';
import type { Stage } from '../pipeline/stage.js';
import type { MemoryKind, MemoryScope } from '../types.js';
import type { MemoryReads } from '../read/memory-reads.js';
import type { VectorCache } from '../vector-cache.js';
import { matchesScope } from '../recall/scope-filter.js';
import { conflictStage } from './conflict-stage.js';
import type { DraftFact, IngestDraft } from './draft.js';
import type { ConflictConfig } from './conflicts.js';
import { byteLength, chunk, importance, normalizeText, trustOf, usefulEntity } from './text.js';

export interface IngestConfig extends ConflictConfig {
  readonly maxTextBytes: number;
  readonly entityLabels: readonly string[];
  readonly linkThreshold: number;
  readonly linkTopK: number;
  readonly modelTimeoutMs: number;
}

const fact = (text: string, kind: MemoryKind): DraftFact => ({
  text,
  kind,
  relations: [],
  mentions: [],
  importance: 0,
  links: [],
  trust: 'normal',
});

const mapFacts = (d: IngestDraft, f: (x: DraftFact, i: number) => DraftFact): IngestDraft => ({
  ...d,
  facts: d.facts.map(f),
});

/** The ingestion pipeline's stages 1–11; assembling and proposing are the engine's. */
export function ingestStages(
  models: Models,
  vectors: VectorCache,
  reads: MemoryReads,
  config: IngestConfig,
): Stage<IngestDraft>[] {
  const timeoutMs = config.modelTimeoutMs;
  return [
    {
      name: 'normalize',
      run: (d) => {
        const text = normalizeText(d.input.content);
        if (text === '')
          return Promise.resolve(
            err({ kind: 'fatal', error: mindlogError('INVALID_ARGUMENT', 'content is empty') }),
          );
        if (byteLength(text) > config.maxTextBytes)
          return Promise.resolve(
            err({
              kind: 'fatal',
              error: mindlogError(
                'PAYLOAD_TOO_LARGE',
                `content is over ${String(config.maxTextBytes)} bytes`,
              ),
            }),
          );
        return Promise.resolve(ok({ ...d, text }));
      },
    },
    { name: 'chunk', run: (d) => Promise.resolve(ok({ ...d, passages: chunk(d.text) })) },
    {
      name: 'extract',
      needs: 'extract',
      timeoutMs,
      async run(d) {
        // A caller-given kind is stored as it is; facts are extracted otherwise (add-only).
        if (d.input.kind) {
          const kind = d.input.kind;
          return ok({ ...d, facts: d.passages.map((p) => fact(p, kind)) });
        }
        const facts: DraftFact[] = [];
        for (const passage of d.passages) {
          const r = await models.extractFacts(passage, { timeoutMs });
          if (!r.ok) return err({ kind: 'skippable', error: r.error });
          for (const f of r.value.facts)
            facts.push({ ...fact(f.text, f.kind), relations: f.relations });
        }
        return ok({ ...d, facts });
      },
      // Without extraction the raw passages are kept as episodic memories (PLAN 12.3).
      fallback: (d) => ({
        ...d,
        facts: d.passages.map((p) => fact(p, d.input.kind ?? 'episodic')),
      }),
    },
    {
      name: 'recognize',
      needs: 'ner',
      timeoutMs,
      async run(d) {
        if (d.facts.length === 0) return ok(d);
        const r = await models.recognize(
          d.facts.map((f) => f.text),
          config.entityLabels,
          { timeoutMs },
        );
        if (!r.ok) return err({ kind: 'skippable', error: r.error });
        return ok(
          mapFacts(d, (f, i) => {
            const spans = r.value.spans[i] ?? [];
            const named = spans
              .filter((s) => usefulEntity(s.text))
              .map((s) => ({ name: s.text, type: s.label }));
            // Relation ends become entities too; their type is the recognised one when known.
            const typeOf = (name: string) =>
              named.find((n) => n.name.toLowerCase() === name.toLowerCase())?.type ?? 'concept';
            const ends = f.relations
              .flatMap((x) => [x.subject, x.object])
              .map((name) => ({ name, type: typeOf(name) }));
            return { ...f, mentions: [...named, ...ends] };
          }),
        );
      },
      fallback: (d) => d,
    },
    {
      name: 'embed',
      needs: 'embed',
      timeoutMs,
      async run(d) {
        if (d.facts.length === 0) return ok(d);
        const r = await models.embed(
          d.facts.map((f) => f.text),
          'passage',
          { timeoutMs },
        );
        if (!r.ok) return err({ kind: 'skippable', error: r.error });
        const { vectors: vs, modelId } = r.value;
        return ok({
          ...mapFacts(d, (f, i) => ({ ...f, ...(vs[i] ? { vector: vs[i] } : {}) })),
          embeddingModel: modelId,
        });
      },
      fallback: (d) => d,
    },
    {
      name: 'importance',
      run: (d) =>
        Promise.resolve(ok(mapFacts(d, (f) => ({ ...f, importance: importance(f.text, f.kind) })))),
    },
    {
      name: 'link-notes',
      async run(d) {
        const { tenant, user } = d.input.scope;
        const index = await vectors.index(tenant, user);
        if (!index || index.size === 0) return ok(d);
        const scope: MemoryScope = d.input.scope;
        return ok(
          mapFacts(d, (f) => {
            if (!f.vector || f.vector.length !== index.dims) return f;
            const near = index
              .search(f.vector, config.linkTopK, (m) => matchesScope(m, scope, true))
              .filter((h) => h.score >= config.linkThreshold);
            return {
              ...f,
              links: near.map((h) => ({
                to: h.id,
                relation: 'related',
                weight: Math.round(h.score * 1000) / 1000,
              })),
            };
          }),
        );
      },
    },
    {
      name: 'trust',
      run: (d) =>
        Promise.resolve(
          ok(mapFacts(d, (f) => ({ ...f, trust: trustOf(d.input.source?.type ?? 'user') }))),
        ),
    },
    conflictStage(models, reads, vectors, config),
  ];
}
