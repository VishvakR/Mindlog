import { decodeKey, prefixRange } from '@mindlog/core';
import type { RangeHooks, RawState } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { compareBytes } from '@mindlog/storage';
import { jobIndexKey, jobIndexPrefix, jobKey } from './job-keys.js';

export interface DueJob {
  readonly tenant: string;
  readonly user: string;
  readonly id: string;
  readonly atMs: bigint;
}

/** Index entries of a range in due order, decoded. */
async function* entries(
  reader: KvReader,
  rangeId: bigint,
): AsyncGenerator<DueJob & { key: Uint8Array }> {
  for await (const [key] of reader.iterate(prefixRange(jobIndexPrefix(rangeId)))) {
    const decoded = decodeKey(key);
    if (!decoded.ok) continue;
    const [, , , atMs, tenant, user, id] = decoded.value.tuple;
    if (typeof atMs !== 'bigint' || typeof tenant !== 'string') continue;
    if (typeof user !== 'string' || typeof id !== 'string') continue;
    yield { key, tenant, user, id, atMs };
  }
}

/** Jobs of a range due at `nowMs`, earliest first, at most `limit`. */
export async function* dueJobs(
  reader: KvReader,
  rangeId: bigint,
  nowMs: bigint,
  limit: number,
): AsyncGenerator<DueJob> {
  let n = 0;
  for await (const { tenant, user, id, atMs } of entries(reader, rangeId)) {
    if (atMs > nowMs || n++ >= limit) return;
    yield { tenant, user, id, atMs };
  }
}

/** Queued and leased jobs of a range, counting at most `limit` (for backpressure). */
export async function queueDepth(
  reader: KvReader,
  rangeId: bigint,
  limit: number,
): Promise<number> {
  let n = 0;
  for await (const _ of entries(reader, rangeId)) if (++n >= limit) break;
  return n;
}

async function move(
  raw: RawState,
  from: bigint,
  to: bigint,
  keep: (job: Uint8Array) => boolean,
): Promise<void> {
  for await (const e of entries(raw.reader, from)) {
    if (!keep(jobKey(e.tenant, e.user, e.id))) continue;
    raw.batch.del(e.key);
    raw.batch.put(jobIndexKey(to, e.atMs, e.tenant, e.user, e.id), new Uint8Array());
  }
}

/** The jobs index follows its jobs on split and merge (ADR-0017). */
export const jobRangeHooks: RangeHooks = {
  split: (raw, left, right, splitKey) =>
    move(raw, left, right, (job) => compareBytes(job, splitKey) >= 0),
  merge: (raw, left, right) => move(raw, right, left, () => true),
};
