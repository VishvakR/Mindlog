import { SYSTEM_TENANT, keyPrefix, prefixRange } from '@mindlog/core';
import { headerKey } from '@mindlog/kv';
import type { Replica, Store } from '@mindlog/multiraft';
import type { Command, CommandResult } from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import { SpanReader, inSpan } from '@mindlog/statemachine';
import type { KvStore } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import type { World } from './world.js';

const DOOMED = 'doomed';
const KEPT = 'kept';
const KEYS = 40;
const LIMIT = 25;
const enc = new TextEncoder();
const RETRY = new Set(['NOT_LEADER', 'RANGE_MOVED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'BUSY']);

export interface TenantNode {
  readonly id: bigint;
  readonly store: Store;
  readonly stateStore: KvStore;
  readonly stamper: CommandStamper;
}

export interface TenantLoadDeps {
  readonly world: World;
  readonly nodes: () => TenantNode[];
  readonly say: (line: string) => void;
  readonly violate: (what: string) => void;
}

/**
 * The tenant deletion workload (phase 10, PLAN 18.3): two tenants write keys;
 * then one is purged range by range with `TenantPurge`, in small batches,
 * under the run's splits, merges, partitions and crashes. After healing, no
 * replica holds a key of the purged tenant, and every acknowledged write of
 * the other tenant is there.
 */
export class TenantLoad {
  readonly #d: TenantLoadDeps;
  #purging = false;
  /** Keys of `kept` whose SET was acknowledged. */
  readonly kept = new Set<string>();
  counts = { writes: 0, purged: 0, passes: 0 };

  constructor(deps: TenantLoadDeps) {
    this.#d = deps;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#d.world.at(this.#d.world.now + ms, resolve);
    });
  }

  #leaderOf(key: Uint8Array): { n: TenantNode; r: Replica } | undefined {
    for (const n of this.#d.nodes())
      for (const r of n.store.replicas())
        if (r.initialised && r.isLeader() && r.rangeId !== 0n && inSpan(r.descriptor, key))
          return { n, r };
    return undefined;
  }

  async #propose(
    find: () => { n: TenantNode; r: Replica } | undefined,
    make: (stamper: CommandStamper) => Command,
  ): Promise<CommandResult | undefined> {
    let command: Command | undefined;
    for (let tries = 0; tries < 8; tries++) {
      const at = find();
      if (at) {
        command ??= make(at.n.stamper);
        const done = await Promise.race([
          at.r.propose(command),
          this.#sleep(5000).then(() => undefined),
        ]);
        if (done?.ok) {
          const out = done.value.result.outcome;
          if (out.case !== 'error' || !RETRY.has(out.value.code)) return done.value.result;
        }
      }
      await this.#sleep(100 * Math.min(tries + 1, 5));
    }
    return undefined;
  }

  /** One SET for either tenant; the doomed one stops writing once its purge starts. */
  async step(): Promise<void> {
    const { world } = this.#d;
    const tenant = this.#purging || world.between(0, 1) < 0.5 ? KEPT : DOOMED;
    const name = `t${String(Math.floor(world.between(0, KEYS)))}`;
    const key = headerKey(tenant, enc.encode(name));
    const r = await this.#propose(
      () => this.#leaderOf(key),
      (s) =>
        s.stamp(tenant, 'sim', {
          case: 'kvWrite',
          value: { argv: [enc.encode('SET'), enc.encode(name), enc.encode('v'.repeat(64))] },
        }),
    );
    if (r && r.outcome.case !== 'error') {
      this.counts.writes++;
      if (tenant === KEPT) this.kept.add(name);
    }
  }

  /** Starts the purge: from now on `doomed` gets no writes. */
  start(): void {
    this.#purging = true;
    this.#d.say('tenants: purging doomed');
  }

  /** One pass over every range there is now; true when every range reported nothing left. */
  async pass(): Promise<boolean> {
    if (!this.#purging) return false;
    this.counts.passes++;
    const ranges = new Map<bigint, Replica>();
    for (const n of this.#d.nodes())
      for (const r of n.store.replicas())
        if (r.initialised && r.rangeId !== 0n) ranges.set(r.rangeId, r);
    let clean = true;
    for (const rangeId of ranges.keys()) {
      for (;;) {
        const r = await this.#propose(
          () => {
            for (const n of this.#d.nodes()) {
              const replica = n.store.replica(rangeId);
              if (replica?.initialised && replica.isLeader()) return { n, r: replica };
            }
            return undefined;
          },
          (s) =>
            s.stamp(SYSTEM_TENANT, 'sim:purger', {
              case: 'tenantPurge',
              value: { tenant: DOOMED, limit: LIMIT },
            }),
        );
        const out = r?.outcome;
        if (out?.case === 'kv' && out.value.kind.case === 'integer') {
          const n = Number(out.value.kind.value);
          this.counts.purged += n;
          if (n > 0) clean = false;
          if (n < LIMIT) break;
          continue;
        }
        // A range that split or merged away answers RANGE_MOVED; the next pass sees its successors.
        clean = false;
        break;
      }
    }
    return clean;
  }

  /** After healing and a clean pass: no replica holds a doomed key, and every kept write is there. */
  async check(): Promise<void> {
    const doomed = keyPrefix(DOOMED);
    if (!doomed.ok) return;
    for (const n of this.#d.nodes())
      for (const r of n.store.replicas()) {
        if (!r.initialised || r.rangeId === 0n) continue;
        for await (const [k] of new SpanReader(n.stateStore, r.descriptor).iterate(
          prefixRange(doomed.value),
          { limit: 1 },
        ))
          this.#d.violate(
            `tenants: node ${String(n.id)} range ${String(r.rangeId)} still holds ${Buffer.from(k).toString('hex')}`,
          );
      }
    for (const name of this.kept) {
      const key = headerKey(KEPT, enc.encode(name));
      const at = this.#leaderOf(key);
      if (!at) {
        this.#d.violate(`tenants: no leader for kept key ${name}`);
        continue;
      }
      const value = await new MvccReader(new SpanReader(at.n.stateStore, at.r.descriptor)).get(key);
      if (value === undefined) this.#d.violate(`tenants: acknowledged kept key ${name} is gone`);
    }
  }
}
