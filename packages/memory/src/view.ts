import type { MemoryRecord } from '@mindlog/proto';
import type { MemoryView } from './types.js';

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
  };
}
