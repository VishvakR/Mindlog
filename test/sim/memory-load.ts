import { err, mindlogError } from '@mindlog/core';
import type { MindlogError, Result } from '@mindlog/core';
import { searchBm25 } from '@mindlog/index-text';
import type { MemoryEngine, MemoryRange } from '@mindlog/memory';
import { MemoryReads, scopeKey } from '@mindlog/memory';
import type { Store } from '@mindlog/multiraft';
import { SpanReader, inSpan } from '@mindlog/statemachine';
import type { KvStore } from '@mindlog/storage';
import type { World } from './world.js';

const TENANT = 'default';
const TOPICS = ['coffee', 'lisbon', 'deploy', 'garden', 'music', 'train', 'budget', 'python'];
const enc = new TextEncoder();

export interface MemoryNode {
  readonly id: bigint;
  readonly store: Store;
  readonly stateStore: KvStore;
  readonly engine: MemoryEngine;
}

export interface MemoryLoadDeps {
  readonly world: World;
  readonly nodes: () => MemoryNode[];
  readonly users: number;
  readonly say: (line: string) => void;
  readonly violate: (what: string) => void;
}

/**
 * The memory workload (phase 5): remember and forget through the real engine
 * (FakeModels) on the leader of each user's range, under the run's faults.
 * After healing, every user's indexes must match its records.
 */
export class MemoryLoad {
  readonly #d: MemoryLoadDeps;
  #seq = 0;
  /** Memories whose commit was acknowledged, by user. */
  readonly remembered = new Map<string, Set<string>>();
  /** Memories whose forget was acknowledged. */
  readonly forgotten = new Set<string>();
  committed = 0;
  inFlight = 0;

  constructor(deps: MemoryLoadDeps) {
    this.#d = deps;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#d.world.at(this.#d.world.now + ms, resolve);
    });
  }

  #leader(user: string): { n: MemoryNode; range: MemoryRange } | undefined {
    const key = scopeKey(TENANT, user);
    for (const n of this.#d.nodes())
      for (const r of n.store.replicas())
        if (r.initialised && r.isLeader() && r.rangeId !== 0n && inSpan(r.descriptor, key))
          return {
            n,
            range: {
              rangeId: r.rangeId,
              proposer: r,
              reader: new SpanReader(n.stateStore, r.descriptor),
            },
          };
    return undefined;
  }

  /** Runs `op` on the user's leader, retrying with the same request id until it answers. */
  async #run<T>(
    user: string,
    op: (engine: MemoryEngine, range: MemoryRange) => Promise<Result<T, MindlogError>>,
  ): Promise<Result<T, MindlogError>> {
    let last: MindlogError = mindlogError('NOT_LEADER', 'no leader');
    this.inFlight++;
    try {
      for (let tries = 0; tries < 12; tries++) {
        const at = this.#leader(user);
        if (at) {
          // A crashed node drops its pending proposals without an answer.
          const done = await Promise.race([
            op(at.n.engine, at.range),
            this.#sleep(5000).then(() => err(mindlogError('DEADLINE_EXCEEDED', 'no answer'))),
          ]);
          if (done.ok) return done;
          last = done.error;
          if (
            !['NOT_LEADER', 'RANGE_MOVED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(last.code)
          )
            return done;
        }
        await this.#sleep(100 * Math.min(tries + 1, 5));
      }
      return err(last);
    } finally {
      this.inFlight--;
    }
  }

  async remember(): Promise<void> {
    const world = this.#d.world;
    const seq = this.#seq++;
    const user = `u${String(world.pick([...Array(this.#d.users).keys()]))}`;
    const topic = world.pick(TOPICS);
    const content = `Fact ${String(seq)} says Ana likes ${topic}. Remember the ${topic} plan.`;
    const requestId = enc.encode(`sim-mem-${String(seq)}`);
    const done = await this.#run(user, (engine, range) =>
      engine.remember(
        range,
        { scope: { tenant: TENANT, user }, content },
        { principal: 'sim', requestId },
      ),
    );
    if (!done.ok) return;
    const ids = this.remembered.get(user) ?? new Set<string>();
    for (const id of done.value.ids) ids.add(id);
    this.remembered.set(user, ids);
    this.committed++;
  }

  async forget(): Promise<void> {
    const world = this.#d.world;
    const users = [...this.remembered.keys()];
    if (users.length === 0) return;
    const user = world.pick(users);
    const live = [...(this.remembered.get(user) ?? [])].filter((id) => !this.forgotten.has(id));
    if (live.length === 0) return;
    const id = world.pick(live);
    const requestId = enc.encode(`sim-forget-${String(this.#seq++)}`);
    const done = await this.#run(user, (engine, range) =>
      engine.forget(
        range,
        { scope: { tenant: TENANT, user }, ids: [id], reason: 'sim' },
        { principal: 'sim', requestId },
      ),
    );
    if (done.ok) this.forgotten.add(id);
  }

  /** After healing: each user's records, postings, stats and vectors agree, on its leader. */
  async check(): Promise<void> {
    for (const user of this.remembered.keys()) {
      const at = this.#leader(user);
      if (!at) {
        this.#d.violate(`memory: no leader for ${user} after healing`);
        continue;
      }
      const reads = new MemoryReads(at.range.reader, TENANT, user);
      const live: Array<{
        id: string;
        terms: Array<{ term: string; count: number }>;
        length: number;
      }> = [];
      const expired = new Set<string>();
      for await (const r of reads.records()) {
        if (r.expiredAt === 0n) live.push({ id: r.id, terms: r.terms, length: r.termLength });
        else expired.add(r.id);
      }
      const ids = new Set([...live.map((r) => r.id), ...expired]);
      for (const id of this.remembered.get(user) ?? [])
        if (!ids.has(id)) this.#d.violate(`memory: acknowledged ${user}/${id} is missing`);
      for (const id of this.forgotten)
        if ((this.remembered.get(user) ?? new Set()).has(id) && !expired.has(id))
          this.#d.violate(`memory: forgotten ${user}/${id} is still live`);
      const postings = reads.postings();
      const stats = await postings.stats();
      const total = live.reduce((n, r) => n + r.length, 0);
      if (stats.docs !== live.length || stats.totalLength !== total)
        this.#d.violate(
          `memory: ${user} stats ${JSON.stringify(stats)} but ${live.length} live, length ${total}`,
        );
      const df = new Map<string, number>();
      for (const r of live) for (const t of r.terms) df.set(t.term, (df.get(t.term) ?? 0) + 1);
      for (const [term, n] of df) {
        const stored = await postings.df(term);
        if (stored !== n) this.#d.violate(`memory: ${user} df(${term}) = ${stored}, expected ${n}`);
      }
      const hits = await searchBm25(postings, [...df.keys(), ...TOPICS], 1000);
      for (const h of hits)
        if (expired.has(h.id)) this.#d.violate(`memory: search returned forgotten ${user}/${h.id}`);
    }
    this.#d.say(`memory: ${this.committed} remembered, ${this.forgotten.size} forgotten`);
  }
}
