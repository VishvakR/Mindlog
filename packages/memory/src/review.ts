import type { MindlogError, Result } from '@mindlog/core';
import { ok } from '@mindlog/core';
import type { MemoryConflict } from '@mindlog/proto';
import type { MemoryReads } from './read/memory-reads.js';
import type { ConflictView, Trust } from './types.js';
import { hlcMs, toView } from './view.js';

// Conflict review reads (ADR-0015); the engine proposes the resolutions.

async function view(reads: MemoryReads, c: MemoryConflict): Promise<ConflictView> {
  const [a, b] = await Promise.all([reads.record(c.a), reads.record(c.b)]);
  return {
    id: c.id,
    ...(a ? { a: toView(a) } : {}),
    ...(b ? { b: toView(b) } : {}),
    scores: [Math.round(c.scoreAb * 1000) / 1000, Math.round(c.scoreBa * 1000) / 1000],
    status: c.status === 'open' ? 'open' : 'resolved',
    policy: c.policy,
    origin: c.origin,
    detectedAtMs: hlcMs(c.detectedAt),
    ...(c.keep ? { keep: c.keep as 'a' | 'b' | 'both' } : {}),
    ...(c.resolvedBy ? { resolvedBy: c.resolvedBy } : {}),
    ...(c.resolvedAt !== 0n ? { resolvedAtMs: hlcMs(c.resolvedAt) } : {}),
  };
}

/** A page of a scope's conflicts, open ones only unless `all`. */
export async function listConflicts(
  reads: MemoryReads,
  options: { all: boolean; limit: number; after?: string | undefined },
): Promise<Result<{ conflicts: ConflictView[]; next?: string }, MindlogError>> {
  const conflicts: ConflictView[] = [];
  for await (const c of reads.conflicts(options.all, options.after)) {
    if (conflicts.length === options.limit)
      return ok({ conflicts, next: conflicts.at(-1)?.id ?? '' });
    conflicts.push(await view(reads, c));
  }
  return ok({ conflicts });
}

export const TRUST_LEVELS: readonly Trust[] = ['verified', 'normal', 'quarantined'];
