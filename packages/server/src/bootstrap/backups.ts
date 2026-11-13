import type { BlobStore } from '@mindlog/blob';
import type { Clock, Counter, Logger, Metrics, MindlogError, Result } from '@mindlog/core';
import { ok } from '@mindlog/core';
import type { Replica } from '@mindlog/multiraft';
import { MemoryStore } from '@mindlog/storage';
import {
  BACKUP_ROOT,
  backupId,
  encodeSnapshot,
  listBackups,
  loadBackup,
  manifestKey,
  sha256,
  snapKey,
} from './backup-format.js';
import type { RangeManifest } from './backup-format.js';
import { restoreInto } from './restore-backup.js';

export interface BackupsDeps {
  readonly blob: BlobStore;
  /** Every replica of this node, its placement driver's included. */
  readonly replicas: () => readonly Replica[];
  readonly nodeId: bigint;
  readonly intervalMs: number;
  readonly keep: number;
  readonly verify: boolean;
  readonly chunkBytes: number;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface BackupResult {
  readonly id: string;
  /** Ranges this node wrote, as decimal ids. */
  readonly ranges: string[];
}

/**
 * Full backups (PLAN 10.5, ADR-0041): each node writes the snapshot of every
 * range it leads to `backups/<id>/`. Scheduled backups share the id of their
 * interval, so the nodes of a cluster fill one folder without talking.
 */
export class Backups {
  readonly #d: BackupsDeps;
  readonly #ranges: Counter;
  readonly #verified: Counter;
  #lastVerified: string | undefined;

  constructor(deps: BackupsDeps) {
    this.#d = deps;
    this.#ranges = deps.metrics.counter({
      name: 'mindlog_backup_ranges_total',
      help: 'Range snapshots written to backups, by outcome',
      labelNames: ['outcome'],
    });
    this.#verified = deps.metrics.counter({
      name: 'mindlog_backup_verify_total',
      help: 'Backups restored into memory to check them, by outcome',
      labelNames: ['outcome'],
    });
  }

  /** The scheduled backup: this interval's folder, then pruning and verification. */
  async tick(): Promise<void> {
    const now = Number(this.#d.clock.now());
    const id = backupId(now - (now % this.#d.intervalMs));
    const done = await this.backupNow(id);
    if (!done.ok) throw new Error(done.error.message);
    const ids = await listBackups(this.#d.blob);
    if (!ids.ok) return;
    for (const old of ids.value.slice(0, Math.max(0, ids.value.length - this.#d.keep)))
      await this.#drop(old);
    const previous = ids.value.filter((i) => i < id).at(-1);
    if (this.#d.verify && previous && previous !== this.#lastVerified && this.#leadsPd()) {
      this.#lastVerified = previous;
      const checked = await verifyBackup(this.#d.blob, previous, this.#d);
      this.#verified.inc(1, { outcome: checked.ok ? 'ok' : 'failed' });
      if (!checked.ok)
        this.#d.logger.error('backup verification failed', {
          id: previous,
          error: checked.error.message,
        });
    }
  }

  /** Backs up every range this node leads that `id` does not hold yet. */
  async backupNow(id?: string): Promise<Result<BackupResult, MindlogError>> {
    const folder = id ?? backupId(Number(this.#d.clock.now()));
    const written: string[] = [];
    for (const replica of this.#d.replicas()) {
      if (!replica.initialised || !replica.isLeader() || replica.failure !== undefined) continue;
      const present = await this.#d.blob.get(manifestKey(folder, replica.rangeId));
      if (!present.ok) return present;
      if (present.value) continue;
      const done = await this.#write(folder, replica);
      this.#ranges.inc(1, { outcome: done.ok ? 'ok' : 'failed' });
      if (!done.ok) return done;
      written.push(replica.rangeId.toString());
    }
    if (written.length > 0) this.#d.logger.info('backup written', { id: folder, ranges: written });
    return ok({ id: folder, ranges: written });
  }

  async #write(id: string, replica: Replica): Promise<Result<void, MindlogError>> {
    const snapshot = await replica.snapshot();
    let bytes: Uint8Array;
    try {
      bytes = await encodeSnapshot(snapshot, replica.rangeId, this.#d.chunkBytes);
    } finally {
      await snapshot.release();
    }
    const put = await this.#d.blob.put(snapKey(id, replica.rangeId), bytes);
    if (!put.ok) return put;
    const manifest: RangeManifest = {
      rangeId: replica.rangeId.toString(),
      index: snapshot.meta.index.toString(),
      term: snapshot.meta.term.toString(),
      bytes: bytes.length,
      sha256: sha256(bytes),
      nodeId: this.#d.nodeId.toString(),
      atMs: Number(this.#d.clock.now()),
    };
    return this.#d.blob.put(
      manifestKey(id, replica.rangeId),
      Buffer.from(JSON.stringify(manifest), 'utf8'),
    );
  }

  async #drop(id: string): Promise<void> {
    const keys = await this.#d.blob.list(`${BACKUP_ROOT}/${id}`);
    if (!keys.ok) return;
    // Manifests first, so a half-deleted backup never looks complete.
    const ordered = [...keys.value].sort(
      (a, b) => Number(b.endsWith('.json')) - Number(a.endsWith('.json')),
    );
    for (const key of ordered) await this.#d.blob.delete(key);
  }

  #leadsPd(): boolean {
    return this.#d.replicas().some((r) => r.rangeId === 0n && r.isLeader());
  }
}

/** Restores a backup into empty in-memory stores: PLAN 10.5's restore into a scratch cluster. */
export async function verifyBackup(
  blob: BlobStore,
  id: string,
  deps: Pick<BackupsDeps, 'clock' | 'logger' | 'metrics'>,
): Promise<Result<number, MindlogError>> {
  const loaded = await loadBackup(blob, id);
  if (!loaded.ok) return loaded;
  const restored = await restoreInto(
    loaded.value,
    { state: new MemoryStore(), pd: new MemoryStore() },
    1n,
    deps,
  );
  return restored.ok ? ok(loaded.value.size) : restored;
}
