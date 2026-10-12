import { decodeKey } from '@mindlog/core';
import type { ApplyHandler } from '@mindlog/statemachine';
import { collectStateVersions, errorResult } from '@mindlog/statemachine';
import type { KvReader, MvccTxn, WriteBatch } from '@mindlog/storage';
import { deadGenerationPrefix, generationPrefix } from '../model/kv-keys.js';
import { integer } from '../model/replies.js';
import { kvResult } from './kv-write-handler.js';

interface Raw {
  readonly reader: KvReader;
  readonly batch: WriteBatch;
}

/**
 * Physically deletes elements of dead generations (ADR-0022) that died before
 * `belowIndex`, oldest first, up to `limit` raw entries. A generation's record
 * is removed only once all its rows are gone, so work resumes where it stopped.
 */
async function collectDeadGenerations(txn: MvccTxn, raw: Raw, belowIndex: bigint, limit: number) {
  let removed = 0;
  for await (const record of txn.scan(deadGenerationPrefix())) {
    const decoded = decodeKey(record.key);
    if (!decoded.ok) continue;
    const [, deathIndex, tenant, name, gen] = decoded.value.tuple;
    if (typeof deathIndex !== 'bigint' || deathIndex >= belowIndex) break;
    if (typeof tenant !== 'string' || !(name instanceof Uint8Array) || typeof gen !== 'bigint')
      continue;
    const prefix = generationPrefix(tenant, name, gen);
    const range = { start: prefix, end: new Uint8Array([...prefix, 0xff]) };
    let finished = true;
    for await (const [key] of raw.reader.iterate(range)) {
      if (removed >= limit) {
        finished = false;
        break;
      }
      raw.batch.del(key);
      removed++;
    }
    if (!finished) break;
    txn.delete(record.key);
  }
  return removed;
}

/**
 * Applies `GcThreshold`: dead generations first, then MVCC versions across the
 * keyspace, within one shared limit. Deterministic for a given state, so every
 * replica reclaims the same rows. Replies with the number of rows removed.
 */
export const gcThresholdHandler: ApplyHandler = {
  body: 'gcThreshold',
  async apply({ command, txn, raw }) {
    if (command.body.case !== 'gcThreshold')
      return errorResult('INTERNAL', 'expected a gcThreshold body');
    const { belowIndex, limit } = command.body.value;
    const budget = limit > 0 ? limit : 1000;
    const dead = await collectDeadGenerations(txn, raw, belowIndex, budget);
    const versions =
      dead < budget ? await collectStateVersions(raw, belowIndex, budget - dead) : undefined;
    return kvResult(integer(dead + (versions?.removed ?? 0)));
  },
};
