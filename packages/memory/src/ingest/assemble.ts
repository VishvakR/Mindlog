import { create } from '@bufbuild/protobuf';
import { termCounts } from '@mindlog/index-text';
import type { EntityEdge, JobSpec, MemoryConflict, NewMemory, Supersede } from '@mindlog/proto';
import {
  EntityEdgeSchema,
  JobSpecSchema,
  MemoryConflictSchema,
  NewMemorySchema,
  SupersedeSchema,
} from '@mindlog/proto';
import type { CallContext } from '../types.js';
import type { IngestDraft } from './draft.js';
import { initialStrength } from './text.js';

/** Relation of entities named in the same memory when no relation was extracted. */
export const CO_MENTION = 'mentioned_with';
/** Entities of one memory that get co-mention edges (pairs grow quadratically). */
const MAX_CO_MENTIONS = 6;

export interface Assembled {
  readonly memories: NewMemory[];
  readonly edges: EntityEdge[];
  readonly conflicts: MemoryConflict[];
  readonly supersede: Supersede[];
}

function vectorBytes(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length * 4);
  const view = new DataView(out.buffer);
  v.forEach((x, i) => {
    view.setFloat32(i * 4, x, true);
  });
  return out;
}

/**
 * PLAN 12.3 stage 12: the commit's memories and edges, with everything apply
 * needs decided here (ids, vectors, BM25 terms; ADR-0032).
 */
export function assemble(
  draft: IngestDraft,
  context: CallContext,
  nextId: () => string,
  derivedFrom: readonly string[] = [],
): Assembled {
  const { scope, source, tags = [], meta, validFromMs, validToMs } = draft.input;
  const memories: NewMemory[] = [];
  const edges: EntityEdge[] = [];
  for (const fact of draft.facts) {
    const id = nextId();
    const { terms, length } = termCounts(fact.text);
    memories.push(
      create(NewMemorySchema, {
        record: {
          id,
          user: scope.user,
          agent: scope.agent ?? '',
          session: scope.session ?? '',
          kind: fact.kind,
          text: fact.text,
          links: [
            ...fact.links,
            ...derivedFrom.map((to) => ({ to, relation: 'derived_from', weight: 1 })),
          ],
          source: {
            type: source?.type ?? 'user',
            ref: source?.ref ?? '',
            principal: context.principal,
          },
          trust: fact.trust,
          importance: fact.importance,
          strength: initialStrength(fact.importance),
          tags: [...tags],
          version: 1,
          embeddingModel: fact.vector ? draft.embeddingModel : '',
          branch: 'main',
          validFrom: BigInt(validFromMs ?? 0),
          validTo: BigInt(validToMs ?? 0),
          metaJson: meta ? JSON.stringify(meta) : '',
          terms: [...terms].map(([term, count]) => ({ term, count })),
          termLength: length,
        },
        vector: fact.vector ? vectorBytes(fact.vector) : new Uint8Array(),
        mentions: fact.mentions.map((m) => ({ name: m.name, type: m.type })),
      }),
    );
    for (const r of fact.relations) {
      const typeOf = (name: string) =>
        fact.mentions.find((m) => m.name.toLowerCase() === name.toLowerCase())?.type ?? 'concept';
      edges.push(
        create(EntityEdgeSchema, {
          srcName: r.subject,
          srcType: typeOf(r.subject),
          relation: r.relation,
          dstName: r.object,
          dstType: typeOf(r.object),
          weight: 1,
          memoryId: id,
        }),
      );
    }
    // Without extracted relations, entities named together are linked, so the graph still connects.
    if (fact.relations.length === 0) {
      const named = fact.mentions.slice(0, MAX_CO_MENTIONS);
      named.forEach((a, i) => {
        for (const b of named.slice(i + 1))
          edges.push(
            create(EntityEdgeSchema, {
              srcName: a.name,
              srcType: a.type,
              relation: CO_MENTION,
              dstName: b.name,
              dstType: b.type,
              weight: 1,
              memoryId: id,
            }),
          );
      });
    }
  }
  // Conflict ids come after every memory id, so callers' preassigned memory ids line up.
  const conflicts: MemoryConflict[] = [];
  const supersede = new Map<string, Supersede>();
  (draft.checks ?? []).forEach((check, i) => {
    const b = memories[i]?.record?.id ?? '';
    for (const c of check.conflicts)
      conflicts.push(
        create(MemoryConflictSchema, {
          id: nextId(),
          a: c.with,
          b,
          scoreAb: c.scoreAB,
          scoreBa: c.scoreBA,
          status: c.status,
          policy: c.policy,
          origin: 'ingest',
          modelId: c.modelId,
          ...(c.status === 'resolved' ? { keep: 'b', resolvedBy: context.principal } : {}),
        }),
      );
    for (const s of check.supersede)
      supersede.set(s.id, create(SupersedeSchema, { id: s.id, validTo: BigInt(s.validTo) }));
  });
  return { memories, edges, conflicts, supersede: [...supersede.values()] };
}

/** Payload of a `memory.enrich` job: what to re-run through the full pipeline. */
export interface EnrichPayload {
  readonly text: string;
  readonly episodic: readonly string[];
  readonly agent?: string;
  readonly session?: string;
  readonly source?: { readonly type: string; readonly ref?: string };
  readonly tags?: readonly string[];
}

export const ENRICH = 'memory.enrich';

export function enrichJob(id: string, payload: EnrichPayload): JobSpec {
  return create(JobSpecSchema, {
    id,
    kind: ENRICH,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  });
}
