import { decodeKey, prefixRange } from '@mindlog/core';
import type { ApplyHandler } from '@mindlog/statemachine';
import { IdempotencyTable, collectStateVersions, errorResult } from '@mindlog/statemachine';
import type { KvReader, WriteBatch } from '@mindlog/storage';
import { deadGenerationPrefix, generationPrefix } from '../model/kv-keys.js';
import { integer } from '../model/replies.js';
import { kvResult } from './kv-write-handler.js';

interface Raw {
  readonly reader: KvReader;
  readonly batch: WriteBatch;
}

/**
 * Physically deletes elements of the range's dead generations (ADR-0022)
 * that died below `belowVersion`, oldest first, up to `limit` raw entries. A
 * generation's record is removed only once all its rows are gone, so work
 * resumes where it stopped.
 */
async function collectDeadGenerations(
  raw: Raw,
  rangeId: bigint,
  belowVersion: bigint,
  limit: number,
) {
  let removed = 0;
  for await (const [recordKey] of raw.reader.iterate(prefixRange(deadGenerationPrefix(rangeId)))) {
    const decoded = decodeKey(recordKey);
    if (!decoded.ok) continue;
    const [, , , deathVersion, tenant, name, gen] = decoded.value.tuple;
    if (typeof deathVersion !== 'bigint' || deathVersion >= belowVersion) break;
    if (typeof tenant !== 'string' || !(name instanceof Uint8Array) || typeof gen !== 'bigint')
      continue;
    let finished = true;
    for await (const [key] of raw.reader.iterate(
      prefixRange(generationPrefix(tenant, name, gen)),
    )) {
      if (removed >= limit) {
        finished = false;
        break;
      }
      raw.batch.del(key);
      removed++;
    }
    if (!finished) break;
    raw.batch.del(recordKey);
  }
  return removed;
}

/**
 * Applies `GcThreshold`: expired idempotency records, dead generations, then
 * MVCC versions across the range, within one shared limit. Deterministic for
 * a given state, so every replica reclaims the same rows. Replies with the
 * number of rows removed.
 */
export const gcThresholdHandler: ApplyHandler = {
  body: 'gcThreshold',
  async apply({ command, raw, descriptor }) {
    if (command.body.case !== 'gcThreshold')
      return errorResult('INTERNAL', 'expected a gcThreshold body');
    const { belowVersion, limit } = command.body.value;
    const budget = limit > 0 ? limit : 1000;
    const { rangeId } = descriptor;
    const idempotency = await IdempotencyTable.collect(raw, rangeId, belowVersion, budget);
    const dead = await collectDeadGenerations(raw, rangeId, belowVersion, budget - idempotency);
    const spent = idempotency + dead;
    const versions =
      spent < budget
        ? await collectStateVersions(raw, descriptor, belowVersion, budget - spent)
        : undefined;
    return kvResult(integer(spent + (versions?.removed ?? 0)));
  },
};
