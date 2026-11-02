import type { Job, MemoryRecord, ScopeLifecycle } from '@mindlog/proto';
import { JobState } from '@mindlog/proto';
import type { JobView, LifecycleView, MemoryView } from './types.js';

/** Physical milliseconds of a packed HLC. */
export const hlcMs = (hlc: bigint): number => Number(hlc >> 16n);

/** A stored record as the interfaces show it. */
export function toView(r: MemoryRecord): MemoryView {
  return {
    id: r.id,
    user: r.user,
    ...(r.agent ? { agent: r.agent } : {}),
    ...(r.session ? { session: r.session } : {}),
    kind: r.kind,
    text: r.text,
    entities: [...r.entities],
    links: r.links.map((l) => ({ to: l.to, relation: l.relation, weight: l.weight })),
    source: {
      type: r.source?.type ?? 'user',
      ...(r.source?.ref ? { ref: r.source.ref } : {}),
      principal: r.source?.principal ?? '',
    },
    trust: r.trust,
    importance: Math.round(r.importance * 1000) / 1000,
    tags: [...r.tags],
    createdAtMs: hlcMs(r.createdAt),
    ...(r.expiredAt !== 0n ? { expiredAtMs: hlcMs(r.expiredAt) } : {}),
    ...(r.forgetReason ? { forgetReason: r.forgetReason } : {}),
    ...(r.validFrom !== 0n ? { validFromMs: Number(r.validFrom) } : {}),
    ...(r.validTo !== 0n ? { validToMs: Number(r.validTo) } : {}),
    tier: r.tier === 'cold' ? 'cold' : 'hot',
    pinned: r.pinned,
    version: r.version,
    strength: Math.round(r.strength * 1000) / 1000,
    recallCount: r.recallCount,
    ...(r.lastRecalledAt !== 0n ? { lastRecalledAtMs: hlcMs(r.lastRecalledAt) } : {}),
    ...(r.metaJson ? { meta: JSON.parse(r.metaJson) as Record<string, unknown> } : {}),
  };
}

const STATES: Partial<Record<JobState, JobView['state']>> = {
  [JobState.QUEUED]: 'queued',
  [JobState.LEASED]: 'leased',
  [JobState.DEAD]: 'dead',
};

/** A job as the interfaces show it; payloads stay internal except a consolidation job's reason. */
export function toJobView(j: Job): JobView {
  let why: string | undefined;
  if (j.kind.startsWith('consolidation.') && j.payload.length > 0)
    try {
      why = (JSON.parse(new TextDecoder().decode(j.payload)) as { why?: string }).why;
    } catch {
      why = undefined;
    }
  return {
    id: j.id,
    kind: j.kind,
    state: STATES[j.state] ?? 'queued',
    attempts: j.attempts,
    deferrals: j.deferrals,
    runAtMs: Number(j.runAtMs),
    ...(j.state === JobState.LEASED ? { leaseUntilMs: Number(j.leaseUntilMs) } : {}),
    ...(j.error ? { error: j.error } : {}),
    createdAtMs: hlcMs(j.createdAt),
    ...(why ? { why } : {}),
  };
}

export function toLifecycleView(s: ScopeLifecycle, coldTier: boolean): LifecycleView {
  return {
    hot: s.hot,
    cold: s.cold,
    writesSinceSleep: s.writesSinceSleep,
    writesSinceEvolve: s.writesSinceEvolve,
    graphSize: s.graphSize,
    graphSizeAtTheme: s.graphSizeAtTheme,
    embedModel: s.embedModel,
    reembed: s.reembed,
    ...(s.lastWriteMs !== 0n ? { lastWriteMs: Number(s.lastWriteMs) } : {}),
    lastRunMs: Object.fromEntries(Object.entries(s.lastRunMs).map(([k, v]) => [k, Number(v)])),
    ...(s.tickAtMs !== 0n ? { tickAtMs: Number(s.tickAtMs) } : {}),
    coldTier,
  };
}
