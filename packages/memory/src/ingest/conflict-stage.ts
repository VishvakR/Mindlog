import type { MindlogError, Result } from '@mindlog/core';
import { err, ok } from '@mindlog/core';
import type { CallOptions, NliClassifier } from '@mindlog/models-client';
import { entityId } from '@mindlog/index-graph';
import type { MemoryRecord } from '@mindlog/proto';
import type { Stage } from '../pipeline/stage.js';
import type { MemoryReads } from '../read/memory-reads.js';
import { matchesScope } from '../recall/scope-filter.js';
import type { MemoryScope, Trust } from '../types.js';
import type { VectorCache } from '../vector-cache.js';
import type { ConflictConfig, Window } from './conflicts.js';
import { applyPolicy, disjoint, supersedes, verdict } from './conflicts.js';
import { minTrust } from './text.js';
import type { Checked, DraftConflict, DraftFact, IngestDraft } from './draft.js';

export interface CheckInput {
  readonly scope: MemoryScope;
  /** Each fact's validity window, in order. */
  readonly windows: readonly Window[];
  readonly facts: readonly DraftFact[];
  /** World time (ms) of the decision. */
  readonly nowMs: number;
}

const windowOf = (r: MemoryRecord): Window => ({
  validFrom: Number(r.validFrom),
  validTo: Number(r.validTo),
});

async function candidates(
  fact: DraftFact,
  window: Window,
  input: CheckInput,
  reads: MemoryReads,
  vectors: VectorCache,
  n: number,
): Promise<MemoryRecord[]> {
  const ids = new Set<string>();
  const { tenant, user } = input.scope;
  const index = await vectors.index(tenant, user);
  if (fact.vector && index && fact.vector.length === index.dims)
    for (const hit of index.search(
      fact.vector,
      n,
      (m) =>
        m.kind === 'semantic' && m.trust !== 'quarantined' && matchesScope(m, input.scope, true),
    ))
      ids.add(hit.id);
  for (const m of fact.mentions)
    for (const id of await reads.mentions(entityId(m.type, m.name), n)) ids.add(id);
  const out: MemoryRecord[] = [];
  for (const id of ids) {
    const r = await reads.record(id);
    if (!r || r.expiredAt !== 0n || r.kind !== 'semantic' || r.trust === 'quarantined') continue;
    if (r.validTo !== 0n && Number(r.validTo) <= input.nowMs) continue;
    if (!matchesScope(r, input.scope, true) || disjoint(windowOf(r), window)) continue;
    out.push(r);
    if (out.length === 2 * n) break;
  }
  return out;
}

const OPEN: Window = { validFrom: 0, validTo: 0 };
const windowAt = (input: CheckInput, i: number): Window => input.windows[i] ?? OPEN;

/**
 * PLAN 13.2 for each new `semantic` fact: compare it with similar and
 * entity-sharing facts in both NLI directions, then apply the temporal rule
 * and the policy. Duplicates link `supports` and lose half their importance.
 */
export async function checkFacts(
  input: CheckInput,
  ports: { nli: NliClassifier; reads: MemoryReads; vectors: VectorCache },
  config: ConflictConfig,
  options: CallOptions,
): Promise<Result<Checked[], MindlogError>> {
  const found = await Promise.all(
    input.facts.map((f, i) =>
      f.kind === 'semantic'
        ? candidates(
            f,
            windowAt(input, i),
            input,
            ports.reads,
            ports.vectors,
            config.conflictCandidates,
          )
        : Promise.resolve([]),
    ),
  );
  const pairs: Array<readonly [string, string]> = [];
  input.facts.forEach((f, i) => {
    for (const c of found[i] ?? []) pairs.push([c.text, f.text], [f.text, c.text]);
  });
  if (pairs.length === 0)
    return ok(input.facts.map((fact) => ({ fact, conflicts: [], supersede: [] })));
  const nli = await ports.nli.classify(pairs, options);
  if (!nli.ok) return nli;
  let p = 0;
  const checked = input.facts.map((original, i): Checked => {
    let fact = original;
    const conflicts: DraftConflict[] = [];
    const supersede: Array<{ id: string; validTo: number }> = [];
    for (const c of found[i] ?? []) {
      const v = verdict(nli.value.results[p], nli.value.results[p + 1], config);
      p += 2;
      if (v.kind === 'duplicate') {
        if (!fact.links.some((l) => l.to === c.id && l.relation === 'supports'))
          fact = {
            ...fact,
            links: [...fact.links, { to: c.id, relation: 'supports', weight: v.score }],
            importance: fact.importance / 2,
          };
        continue;
      }
      if (v.kind !== 'contradiction') continue;
      const ends = supersedes(windowOf(c), windowAt(input, i));
      if (ends !== undefined) {
        supersede.push({ id: c.id, validTo: ends });
        continue;
      }
      const outcome = applyPolicy(config.conflictPolicy, c.trust as Trust, fact.trust);
      fact = { ...fact, trust: minTrust(fact.trust, outcome.trust) };
      if (outcome.supersedeExisting) supersede.push({ id: c.id, validTo: input.nowMs });
      conflicts.push({
        with: c.id,
        scoreAB: v.scoreAB,
        scoreBA: v.scoreBA,
        status: outcome.status,
        policy: config.conflictPolicy,
        modelId: nli.value.modelId,
      });
    }
    return { fact, conflicts, supersede };
  });
  return ok(checked);
}

/** PLAN 12.3 stage 10: conflict detection before commit, skipped without the NLI model. */
export function conflictStage(
  nli: NliClassifier,
  reads: MemoryReads,
  vectors: VectorCache,
  config: ConflictConfig & { readonly modelTimeoutMs: number },
): Stage<IngestDraft> {
  const timeoutMs = config.modelTimeoutMs;
  return {
    name: 'detect-conflicts',
    needs: 'nli',
    timeoutMs,
    async run(d, context) {
      // Branch facts are checked against main when the branch merges (ADR-0013).
      if (d.input.branch) return ok(d);
      const r = await checkFacts(
        {
          scope: d.input.scope,
          windows: d.facts.map(() => ({
            validFrom: d.input.validFromMs ?? 0,
            validTo: d.input.validToMs ?? 0,
          })),
          facts: d.facts,
          nowMs: Number(context.clock.now()),
        },
        { nli, reads, vectors },
        config,
        { timeoutMs },
      );
      if (!r.ok) return err({ kind: 'skippable', error: r.error });
      return ok({ ...d, facts: r.value.map((c) => c.fact), checks: r.value });
    },
    fallback: (d) => d,
  };
}
