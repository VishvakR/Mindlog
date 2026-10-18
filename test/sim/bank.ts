import { ok, err, mindlogError, packHlc } from '@mindlog/core';
import type { MindlogError, Result } from '@mindlog/core';
import type { KvCommandRegistry } from '@mindlog/kv';
import { headerKey } from '@mindlog/kv';
import type { Store } from '@mindlog/multiraft';
import type { TxnOutcome } from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import { inSpan } from '@mindlog/statemachine';
import type { KvStore } from '@mindlog/storage';
import type { TxnCluster, TxnOp } from '@mindlog/txn';
import { TxnCoordinator, scanLocks, snapshotRead } from '@mindlog/txn';
import type { World } from './world.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string): Uint8Array => enc.encode(s);
const BODY = {
  prewrite: 'txnPrewrite',
  commit: 'txnCommit',
  rollback: 'txnRollback',
  check: 'txnCheck',
} as const;

export interface BankNode {
  readonly id: bigint;
  readonly store: Store;
  readonly stateStore: KvStore;
  readonly stamper: CommandStamper;
}

export interface BankDeps {
  readonly world: World;
  readonly registry: KvCommandRegistry;
  /** Nodes that are up now. */
  readonly nodes: () => BankNode[];
  readonly startMs: number;
  readonly accounts: number;
  readonly initial: number;
  readonly say: (line: string) => void;
  readonly violate: (what: string) => void;
  readonly splitSome: () => void;
}

/** Account names spread over the keyspace so splits put them in different ranges. */
export const accountName = (i: number): string =>
  `acct-${String.fromCharCode(97 + ((i * 7) % 26))}${i}`;

/**
 * The bank-transfer workload of the phase 4 gate (ADR-0030): accounts live in
 * different ranges, transfers are transactions, and the total never changes.
 */
export class Bank {
  readonly #d: BankDeps;
  readonly coordinator: TxnCoordinator;
  readonly cluster: TxnCluster;
  #last = 0n;
  #ready = false;
  #inFlight = 0;
  readonly pending = new Map<number, string>();
  #seq = 0;
  committed = 0;
  aborted = 0;
  audits = 0;

  constructor(deps: BankDeps) {
    this.#d = deps;
    this.cluster = {
      tso: () => Promise.resolve(ok(this.#tso())),
      place: (_tenant, keys) => this.#place(keys),
      run: (tenant, probe, op) => this.#run(tenant, probe, op),
    };
    this.coordinator = new TxnCoordinator({
      cluster: this.cluster,
      keysOf: (argv) => deps.registry.keysOf(argv),
      sleep: (ms) => this.#sleep(ms),
      lockTtlMs: 4000,
    });
  }

  get expectedTotal(): number {
    return this.#d.accounts * this.#d.initial;
  }

  get idle(): boolean {
    return this.#inFlight === 0;
  }

  #tso(): bigint {
    const physical = BigInt(this.#d.startMs + Math.floor(this.#d.world.now));
    this.#last = packHlc(physical, 0n) > this.#last ? packHlc(physical, 0n) : this.#last + 1n;
    return this.#last;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#d.world.at(this.#d.world.now + ms, resolve);
    });
  }

  #leader(probe: Uint8Array, tenant: string) {
    const header = headerKey(tenant, probe);
    for (const n of this.#d.nodes())
      for (const r of n.store.replicas())
        if (r.initialised && r.isLeader() && r.rangeId !== 0n && inSpan(r.descriptor, header))
          return { n, r };
    return undefined;
  }

  #place(keys: readonly Uint8Array[]): Promise<Result<bigint[], MindlogError>> {
    const out: bigint[] = [];
    for (const key of keys) {
      const header = headerKey('default', key);
      const found = this.#d
        .nodes()
        .flatMap((n) => n.store.replicas())
        .find((r) => r.initialised && r.rangeId !== 0n && inSpan(r.descriptor, header));
      if (!found) return Promise.resolve(err(mindlogError('RANGE_MOVED', 'no range for the key')));
      out.push(found.rangeId);
    }
    return Promise.resolve(ok(out));
  }

  /** Reaches the range's leader, retrying while leadership or the range moves (every op is idempotent). */
  async #run(
    tenant: string,
    probe: Uint8Array,
    op: TxnOp,
  ): Promise<Result<TxnOutcome, MindlogError>> {
    const last: MindlogError = mindlogError('NOT_LEADER', 'no leader');
    const id = this.#seq++;
    this.pending.set(id, `${op.kind} since ${this.#d.world.now.toFixed(0)}`);
    try {
      return await this.#runLoop(tenant, probe, op, last, id);
    } finally {
      this.pending.delete(id);
    }
  }

  async #runLoop(
    tenant: string,
    probe: Uint8Array,
    op: TxnOp,
    first: MindlogError,
    id: number,
  ): Promise<Result<TxnOutcome, MindlogError>> {
    let last = first;
    for (let tries = 0; tries < 12; tries++) {
      const at = this.#leader(probe, tenant);
      if (at) {
        const s = at.r.status();
        this.pending.set(
          id,
          `${op.kind} on n${at.n.id} r${at.r.rangeId} ${s.role} term ${s.term} lead ${s.lead} quiesced ${at.r.quiesced} since ${this.#d.world.now.toFixed(0)} try ${tries}`,
        );
        // A node that crashes drops its pending proposals without an answer, like a cut connection.
        const done = await Promise.race([
          this.#once(at.n, at.r, tenant, op),
          this.#sleep(5000).then(() =>
            err(mindlogError('DEADLINE_EXCEEDED', 'no answer from the node')),
          ),
        ]);
        if (done.ok) return done;
        last = done.error;
        if (!['NOT_LEADER', 'RANGE_MOVED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(last.code))
          return done;
      }
      await this.#sleep(100 * Math.min(tries + 1, 5));
    }
    return err(last);
  }

  async #once(
    node: BankNode,
    replica: ReturnType<Store['replicas']>[number],
    tenant: string,
    op: TxnOp,
  ): Promise<Result<TxnOutcome, MindlogError>> {
    if (op.kind === 'read') {
      const ready = await replica.read('linearizable');
      if (!ready.ok) return ready;
      return snapshotRead(
        {
          registry: this.#d.registry,
          state: node.stateStore,
          descriptor: replica.descriptor,
          tenant,
        },
        op.argv,
        op.ts,
      );
    }
    const body = { case: BODY[op.kind], value: op.body } as Parameters<CommandStamper['stamp']>[2];
    const proposed = await replica.propose(node.stamper.stamp(tenant, 'bank', body));
    if (!proposed.ok) return proposed;
    const outcome = proposed.value.result.outcome;
    if (outcome.case === 'txn') return ok(outcome.value);
    if (outcome.case === 'error') return err(mindlogError('RANGE_MOVED', outcome.value.message));
    return err(mindlogError('INTERNAL', 'not a transaction result'));
  }

  // ---- workload ----

  /** Deposits the initial balances in one transaction, retrying until it commits. */
  async setup(): Promise<void> {
    const names = Array.from({ length: this.#d.accounts }, (_, i) => accountName(i));
    for (;;) {
      this.#inFlight++;
      const r = await this.coordinator.run('default', (txn) => {
        for (const n of names) txn.write([b('SET'), b(n), b(String(this.#d.initial))]);
        return Promise.resolve(ok(undefined));
      });
      this.#inFlight--;
      if (r.ok) break;
      await this.#sleep(300);
    }
    this.#ready = true;
    this.#d.say(`bank: ${names.length} accounts funded`);
    // Spread the accounts over several ranges.
    for (let i = 0; i < 3; i++) {
      this.#d.splitSome();
      await this.#sleep(400);
    }
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** One transfer between two random accounts; the total must not change however it ends. */
  async transfer(): Promise<void> {
    if (!this.#ready) return;
    const { world, accounts } = this.#d;
    const from = accountName(Math.floor(world.between(0, accounts)));
    let to = accountName(Math.floor(world.between(0, accounts)));
    if (to === from)
      to = accountName((accounts + 1 - 1 + Math.floor(world.between(1, accounts))) % accounts);
    if (to === from) return;
    const amount = 1 + Math.floor(world.between(0, 10));
    this.#inFlight++;
    const r = await this.coordinator.run('default', async (txn) => {
      const a = await txn.get([b('GET'), b(from)]);
      if (!a.ok) return a;
      const balance = a.value.kind.case === 'bulk' ? Number(dec.decode(a.value.kind.value)) : 0;
      if (balance < amount) return ok(false);
      txn.write([b('DECRBY'), b(from), b(String(amount))]);
      txn.write([b('INCRBY'), b(to), b(String(amount))]);
      return ok(true);
    });
    this.#inFlight--;
    if (r.ok && r.value.value) this.committed++;
    else if (!r.ok) this.aborted++;
  }

  /** Reads every account at one timestamp: the total is the same in every snapshot. */
  async audit(): Promise<void> {
    if (!this.#ready) return;
    this.#inFlight++;
    const r = await this.coordinator.run('default', async (txn) => {
      let total = 0;
      for (let i = 0; i < this.#d.accounts; i++) {
        const got = await txn.get([b('GET'), b(accountName(i))]);
        if (!got.ok) return got;
        const balance =
          got.value.kind.case === 'bulk' ? Number(dec.decode(got.value.kind.value)) : NaN;
        if (!(balance >= 0))
          this.#d.violate(
            `bank: account ${accountName(i)} holds ${balance} (${got.value.kind.case} at ${String(txn.startTs >> 16n)})`,
          );
        total += balance;
      }
      return ok(total);
    });
    this.#inFlight--;
    if (!r.ok) return;
    this.audits++;
    if (r.value.value !== this.expectedTotal)
      this.#d.violate(`bank: a snapshot sums to ${r.value.value}, expected ${this.expectedTotal}`);
  }

  /** Resolves every lock the leaders still hold (the job's work), then reports what remains. */
  async sweep(): Promise<number> {
    let remaining = 0;
    for (const n of this.#d.nodes()) {
      for (const r of n.store.replicas()) {
        if (!r.isLeader() || !r.initialised || r.rangeId === 0n) continue;
        for (const held of await scanLocks(n.stateStore, r.rangeId)) {
          remaining++;
          await this.coordinator.resolve(
            held.tenant,
            held.key,
            held.lock.primary,
            held.lock.startTs,
          );
        }
      }
    }
    return remaining;
  }

  /** Locks anywhere on this node, resolved or not (replicas of every range). */
  async locksLeft(): Promise<number> {
    let n = 0;
    for (const node of this.#d.nodes())
      for (const r of node.store.replicas())
        if (r.initialised && r.rangeId !== 0n)
          n += (await scanLocks(node.stateStore, r.rangeId)).length;
    return n;
  }
}
