import type { MessageInitShape } from '@bufbuild/protobuf';
import { ok } from '@mindlog/core';
import type { Worker } from '@mindlog/jobs';
import { LIFECYCLE_JOBS } from '@mindlog/memory';
import type { MemoryEvolveSchema } from '@mindlog/proto';
import type { ConsolidationDeps } from '../worker-kit.js';
import { worker } from '../worker-kit.js';

/** Cosine at which two memories are duplicates (PLAN 12.6). */
export const DUPLICATE_SIMILARITY = 0.93;
const DUPLICATE_TAG = 'duplicate';
/** Duplicates marked per command. */
const BATCH = 50;
const KINDS = new Set(['semantic', 'procedural', 'episodic']);

/**
 * Deduplicator (PLAN 12.6): a memory nearly identical to an older one is
 * marked its duplicate (half the importance, a `duplicate` tag and
 * `meta.duplicateOf`), and the older one gains a `supersedes` link. Nothing
 * is deleted.
 */
export function dedupWorker(d: ConsolidationDeps): Worker {
  return worker(LIFECYCLE_JOBS.dedup, d, async (run) => {
    const index = await d.engine.vectorIndex(run.scope);
    if (!index) return run.finish();
    const marked = new Set<string>();
    let evolve: Array<MessageInitShape<typeof MemoryEvolveSchema>> = [];
    let n = 0;
    for await (const r of run.reads.records()) {
      if (r.expiredAt !== 0n || r.tier === 'cold' || !KINDS.has(r.kind)) continue;
      if (r.tags.includes(DUPLICATE_TAG)) {
        marked.add(r.id);
        continue;
      }
      const v = index.get(r.id);
      if (!v) continue;
      // Records come in id (creation) order, so a match with a smaller id is older.
      const best = index
        .search(v, 5, (m, id) => id < r.id && m.kind === r.kind && !marked.has(id))
        .find((h) => h.score >= DUPLICATE_SIMILARITY);
      if (!best) continue;
      marked.add(r.id);
      evolve.push(
        {
          id: r.id,
          importance: r.importance / 2,
          setImportance: true,
          tags: [...r.tags, DUPLICATE_TAG],
          setTags: true,
          metaJson: JSON.stringify({ duplicateOf: best.id, similarity: best.score }),
        },
        { id: best.id, addLinks: [{ to: r.id, relation: 'supersedes', weight: best.score }] },
      );
      if (evolve.length >= 2 * BATCH) {
        const done = await run.maintain(n++, { evolve });
        if (!done.ok) return done;
        evolve = [];
      }
    }
    if (evolve.length > 0) {
      const done = await run.maintain(n, { evolve });
      if (!done.ok) return done;
    }
    return ok({ completed: false });
  });
}
