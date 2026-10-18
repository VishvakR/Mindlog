import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type {
  KvReply,
  TxnCheck,
  TxnCommit,
  TxnOutcome,
  TxnPrewrite,
  TxnRollback,
} from '@mindlog/proto';
import { TxnStatus } from '@mindlog/proto';

/** One step of a transaction, run by the leader of the range that holds `probe` (ADR-0030). */
export type TxnOp =
  | { readonly kind: 'read'; readonly ts: bigint; readonly argv: readonly Uint8Array[] }
  | { readonly kind: 'prewrite'; readonly body: TxnPrewrite }
  | { readonly kind: 'commit'; readonly body: TxnCommit }
  | { readonly kind: 'rollback'; readonly body: TxnRollback }
  | { readonly kind: 'check'; readonly body: TxnCheck };

/**
 * What the coordinator needs of the cluster. Declared here, where it is used;
 * the request layer implements it over the router, the simulator over its nodes.
 * `run` finds the leader of the range, retrying while leadership moves.
 */
export interface TxnCluster {
  /** A new timestamp, later than every earlier one. */
  tso(): Promise<Result<bigint, MindlogError>>;
  /** The range of each key. */
  place(tenant: string, keys: readonly Uint8Array[]): Promise<Result<bigint[], MindlogError>>;
  run(tenant: string, probe: Uint8Array, op: TxnOp): Promise<Result<TxnOutcome, MindlogError>>;
}

export interface TxnCoordinatorDeps {
  readonly cluster: TxnCluster;
  /** The keys a write command touches. */
  readonly keysOf: (argv: readonly Uint8Array[]) => readonly Uint8Array[];
  /** Waits; the simulator supplies virtual time. */
  readonly sleep: (ms: number) => Promise<void>;
  /** How long a lock protects a transaction that stops (default 3 s). */
  readonly lockTtlMs?: number;
  /** Whole-transaction attempts after a write conflict (default 5). */
  readonly attempts?: number;
}

const DEFAULT_TTL_MS = 3000;
const RESOLVE_TRIES = 8;

/** A transaction in progress: reads see the snapshot at `startTs`; writes are staged until commit. */
export class Txn {
  readonly startTs: bigint;
  readonly #tenant: string;
  readonly #c: TxnCoordinator;
  readonly #writes: Uint8Array[][] = [];

  constructor(c: TxnCoordinator, tenant: string, startTs: bigint) {
    this.#c = c;
    this.#tenant = tenant;
    this.startTs = startTs;
  }

  /** A read as of `startTs`, resolving any lock it meets. Staged writes are not visible to it. */
  get(argv: readonly Uint8Array[]): Promise<Result<KvReply, MindlogError>> {
    return this.#c.read(this.#tenant, this.startTs, argv);
  }

  /** Stages a write command; it runs, atomically with the others, when the transaction commits. */
  write(argv: readonly Uint8Array[]): void {
    this.#writes.push([...argv]);
  }

  get staged(): readonly Uint8Array[][] {
    return this.#writes;
  }
}

interface Group {
  readonly rangeId: bigint;
  readonly probe: Uint8Array;
  readonly writes: Uint8Array[][];
  /** Every key locked in this range, in write order. */
  readonly keys: Uint8Array[];
}

/**
 * Drives Percolator transactions (ADR-0030): snapshot reads at a TSO timestamp,
 * prewrite on every range, then commit the primary (the commit point) and the
 * rest. A stopped coordinator leaves locks that readers and the resolver clear.
 */
export class TxnCoordinator {
  readonly #d: TxnCoordinatorDeps;

  constructor(deps: TxnCoordinatorDeps) {
    this.#d = deps;
  }

  /** Runs `fn` and commits what it staged, starting over (up to `attempts`) after a write conflict. */
  async run<T>(
    tenant: string,
    fn: (txn: Txn) => Promise<Result<T, MindlogError>>,
  ): Promise<Result<{ value: T; replies: Array<KvReply | undefined> }, MindlogError>> {
    let last: MindlogError = mindlogError('CONFLICT', 'transaction conflict');
    for (let attempt = 0; attempt < (this.#d.attempts ?? 5); attempt++) {
      const startTs = await this.#d.cluster.tso();
      if (!startTs.ok) return startTs;
      const txn = new Txn(this, tenant, startTs.value);
      const value = await fn(txn);
      if (!value.ok) return value;
      const committed = await this.commit(tenant, txn);
      if (committed.ok) return ok({ value: value.value, replies: committed.value });
      if (committed.error.code !== 'CONFLICT') return committed;
      last = committed.error;
      await this.#d.sleep(10 * 2 ** attempt);
    }
    return err(last);
  }

  /** A snapshot read at `ts`: locks it meets are resolved, then it is read again. */
  async read(
    tenant: string,
    ts: bigint,
    argv: readonly Uint8Array[],
  ): Promise<Result<KvReply, MindlogError>> {
    const probe = this.#d.keysOf(argv)[0];
    if (!probe) return err(mindlogError('INVALID_ARGUMENT', 'a transactional read needs a key'));
    for (let tries = 0; tries < RESOLVE_TRIES; tries++) {
      const r = await this.#d.cluster.run(tenant, probe, { kind: 'read', ts, argv });
      if (!r.ok) return r;
      if (r.value.status !== TxnStatus.LOCKED) {
        const reply = r.value.replies[0];
        return reply ? ok(reply) : err(mindlogError('INTERNAL', 'snapshot read had no reply'));
      }
      await this.#waitFor(tenant, r.value, tries);
    }
    return err(mindlogError('UNAVAILABLE', 'the key stayed locked by a running transaction'));
  }

  /** Resolves one lock: rolls its transaction forward or back, or reports it still running. */
  async resolve(
    tenant: string,
    lockedKey: Uint8Array,
    primary: Uint8Array,
    startTs: bigint,
  ): Promise<Result<'resolved' | 'running', MindlogError>> {
    const checked = await this.#d.cluster.run(tenant, primary, {
      kind: 'check',
      body: { $typeName: 'mindlog.v1.TxnCheck', startTs, primary },
    });
    if (!checked.ok) return checked;
    if (checked.value.status === TxnStatus.LOCKED) return ok('running');
    const done =
      checked.value.status === TxnStatus.COMMITTED
        ? await this.#d.cluster.run(tenant, lockedKey, {
            kind: 'commit',
            body: {
              $typeName: 'mindlog.v1.TxnCommit',
              startTs,
              commitTs: checked.value.commitTs,
              keys: [lockedKey],
              primary,
            },
          })
        : await this.#d.cluster.run(tenant, lockedKey, {
            kind: 'rollback',
            body: { $typeName: 'mindlog.v1.TxnRollback', startTs, keys: [lockedKey] },
          });
    return done.ok ? ok('resolved') : done;
  }

  async #waitFor(tenant: string, locked: TxnOutcome, tries: number): Promise<void> {
    const resolved = await this.resolve(
      tenant,
      locked.lockedKey,
      locked.lockedPrimary,
      locked.lockedStartTs,
    );
    // A running transaction is given time to finish; its lock expires if it has stopped.
    if (!resolved.ok || resolved.value === 'running')
      await this.#d.sleep(25 * 2 ** Math.min(tries, 6));
  }

  /** Prewrites, takes the commit timestamp, commits the primary, then the rest. */
  async commit(
    tenant: string,
    txn: Txn,
  ): Promise<Result<Array<KvReply | undefined>, MindlogError>> {
    const writes = txn.staged;
    if (writes.length === 0) return ok([]);
    const keysOf = writes.map((w) => this.#d.keysOf(w));
    const owner = keysOf.map((k) => k[0]);
    const primary = owner[0];
    if (!primary || owner.some((k) => !k))
      return err(mindlogError('INVALID_ARGUMENT', 'a transactional write needs a key'));
    const everyKey = keysOf.flat();
    const placed = await this.#d.cluster.place(tenant, everyKey);
    if (!placed.ok) return placed;
    const rangeOfKey = new Map(everyKey.map((k, i) => [hex(k), placed.value[i] as bigint]));
    const groups = new Map<bigint, Group>();
    for (const [i, w] of writes.entries()) {
      const ks = keysOf[i] as Uint8Array[];
      const rangeId = rangeOfKey.get(hex(ks[0] as Uint8Array)) as bigint;
      if (ks.some((k) => rangeOfKey.get(hex(k)) !== rangeId))
        return err(mindlogError('CROSS_RANGE', 'one command touches keys in different ranges'));
      const g = groups.get(rangeId) ?? {
        rangeId,
        probe: ks[0] as Uint8Array,
        writes: [],
        keys: [],
      };
      g.writes.push(w);
      g.keys.push(...ks);
      groups.set(rangeId, g);
    }
    const all = [...groups.values()];
    const prewritten = await Promise.all(
      all.map((g) => this.#prewrite(tenant, txn.startTs, primary, g)),
    );
    const failed = prewritten.find((r) => !r.ok);
    if (failed) {
      await this.#rollback(tenant, txn.startTs, all);
      return failed;
    }
    const commitTs = await this.#d.cluster.tso();
    if (!commitTs.ok) {
      await this.#rollback(tenant, txn.startTs, all);
      return commitTs;
    }
    const first = all.find((g) => rangeOfKey.get(hex(primary)) === g.rangeId) as Group;
    const decided = await this.#commit(tenant, txn.startTs, commitTs.value, primary, first);
    if (!decided.ok) return decided;
    // The transaction is committed: failures below leave locks for readers and the resolver to roll forward.
    const rest = await Promise.all(
      all
        .filter((g) => g !== first)
        .map((g) => this.#commit(tenant, txn.startTs, commitTs.value, primary, g)),
    );
    const replyOf = new Map<Group, KvReply[]>([[first, decided.value]]);
    for (const [i, g] of all.filter((g) => g !== first).entries()) {
      const r = rest[i];
      if (r?.ok) replyOf.set(g, r.value);
    }
    const cursor = new Map<Group, number>();
    return ok(
      writes.map((_, i) => {
        const g = groups.get(rangeOfKey.get(hex(owner[i] as Uint8Array)) as bigint) as Group;
        const at = cursor.get(g) ?? 0;
        cursor.set(g, at + 1);
        return replyOf.get(g)?.[at];
      }),
    );
  }

  async #prewrite(
    tenant: string,
    startTs: bigint,
    primary: Uint8Array,
    g: Group,
  ): Promise<Result<void, MindlogError>> {
    const op: TxnOp = {
      kind: 'prewrite',
      body: {
        $typeName: 'mindlog.v1.TxnPrewrite',
        startTs,
        primary,
        ttlMs: BigInt(this.#d.lockTtlMs ?? DEFAULT_TTL_MS),
        writes: g.writes.map((argv) => ({ $typeName: 'mindlog.v1.KvWrite', argv })),
      },
    };
    for (let tries = 0; tries < RESOLVE_TRIES; tries++) {
      const r = await this.#d.cluster.run(tenant, g.probe, op);
      if (!r.ok) return r;
      if (r.value.status === TxnStatus.OK) return ok(undefined);
      if (r.value.status !== TxnStatus.LOCKED)
        return err(
          mindlogError('CONFLICT', 'a newer write exists, or this transaction was rolled back'),
        );
      await this.#waitFor(tenant, r.value, tries);
    }
    return err(mindlogError('CONFLICT', 'a key stayed locked by another transaction'));
  }

  async #commit(
    tenant: string,
    startTs: bigint,
    commitTs: bigint,
    primary: Uint8Array,
    g: Group,
  ): Promise<Result<KvReply[], MindlogError>> {
    const r = await this.#d.cluster.run(tenant, g.probe, {
      kind: 'commit',
      body: { $typeName: 'mindlog.v1.TxnCommit', startTs, commitTs, keys: g.keys, primary },
    });
    if (!r.ok) {
      // The commit may or may not have been applied: the outcome is unknown, not a failure.
      return err(mindlogError('DEADLINE_EXCEEDED', `commit outcome unknown: ${r.error.message}`));
    }
    if (r.value.status === TxnStatus.ABORTED)
      return err(mindlogError('CONFLICT', 'the transaction was rolled back before it committed'));
    return ok(r.value.replies);
  }

  /** Best effort: whatever is not released here expires and is resolved. */
  async #rollback(tenant: string, startTs: bigint, groups: readonly Group[]): Promise<void> {
    await Promise.all(
      groups.map((g) =>
        this.#d.cluster.run(tenant, g.probe, {
          kind: 'rollback',
          body: { $typeName: 'mindlog.v1.TxnRollback', startTs, keys: g.keys },
        }),
      ),
    );
  }
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
