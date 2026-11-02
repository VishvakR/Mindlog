import type { MergePolicy } from '@mindlog/memory';
import { MemoryReads } from '@mindlog/memory';
import type { MemoryLoad } from './memory-load.js';
import type { World } from './world.js';

const TENANT = 'default';
const POLICIES: MergePolicy[] = ['raise', 'prefer_branch', 'prefer_main', 'abort'];
const enc = new TextEncoder();

interface Branch {
  readonly user: string;
  readonly name: string;
  /** Acknowledged memories written on the branch. */
  readonly memories: Set<string>;
  /** Main memories the branch forgot (acknowledged). */
  readonly forgot: Set<string>;
  /** Acknowledged outcome; `unknown` when a merge or drop got no answer. */
  status: 'open' | 'merged' | 'dropped' | 'unknown';
  /** With a merge: the branch memories that went to main. */
  added: Set<string>;
}

export interface BranchLoadDeps {
  readonly world: World;
  readonly memory: MemoryLoad;
  readonly say: (line: string) => void;
  readonly violate: (what: string) => void;
}

/**
 * The branch workload (phase 7, ADR-0013): create branches of user scopes,
 * write and forget on them (some facts contradict main), then merge under a
 * random policy or drop, under the run's faults. Every replica must end with
 * the same state (the scenario's state hashes), and acknowledged outcomes
 * must hold on main.
 */
export class BranchLoad {
  readonly #d: BranchLoadDeps;
  readonly #branches: Branch[] = [];
  #seq = 0;

  constructor(deps: BranchLoadDeps) {
    this.#d = deps;
  }

  #open(): Branch[] {
    return this.#branches.filter((b) => b.status === 'open');
  }

  async create(): Promise<void> {
    const users = [...this.#d.memory.remembered.keys()];
    if (users.length === 0 || this.#open().length >= 3) return;
    const user = this.#d.world.pick(users);
    const name = `b${String(this.#seq++)}`;
    const requestId = enc.encode(`sim-branch-${name}`);
    const done = await this.#d.memory.run(user, ({ engine }, range) =>
      engine.createBranch(range, { tenant: TENANT, user }, name, { principal: 'sim', requestId }),
    );
    if (done.ok)
      this.#branches.push({
        user,
        name,
        memories: new Set(),
        forgot: new Set(),
        status: 'open',
        added: new Set(),
      });
  }

  async write(): Promise<void> {
    const open = this.#open();
    if (open.length === 0) return;
    const world = this.#d.world;
    const b = world.pick(open);
    const seq = this.#seq++;
    const scope = { tenant: TENANT, user: b.user };
    if (world.chance(1 / 4)) {
      // Forget a main memory on the branch only.
      const main = [...(this.#d.memory.remembered.get(b.user) ?? [])];
      if (main.length === 0) return;
      const id = world.pick(main);
      const done = await this.#d.memory.run(b.user, ({ engine }, range) =>
        engine.forget(
          range,
          { scope, ids: [id], reason: 'sim branch', branch: b.name },
          { principal: 'sim', requestId: enc.encode(`sim-bforget-${String(seq)}`) },
        ),
      );
      if (done.ok && done.value.count > 0) b.forgot.add(id);
      return;
    }
    // Some branch facts negate main's, so merges meet contradictions.
    const content = world.chance(1 / 2)
      ? `Fact ${String(seq)} says Ana does not like coffee.`
      : `Fact ${String(seq)} says Ana likes ${b.name} plans.`;
    const done = await this.#d.memory.run(b.user, ({ engine }, range) =>
      engine.remember(
        range,
        { scope, content, kind: 'semantic', branch: b.name },
        { principal: 'sim', requestId: enc.encode(`sim-bwrite-${String(seq)}`) },
      ),
    );
    if (done.ok) for (const id of done.value.ids) b.memories.add(id);
  }

  async close(): Promise<void> {
    const open = this.#open();
    if (open.length === 0) return;
    const world = this.#d.world;
    const b = world.pick(open);
    const scope = { tenant: TENANT, user: b.user };
    const requestId = enc.encode(`sim-close-${b.name}`);
    if (world.chance(1 / 5)) {
      const done = await this.#d.memory.run(b.user, ({ engine }, range) =>
        engine.dropBranch(range, scope, b.name, { principal: 'sim', requestId }),
      );
      b.status = done.ok ? 'dropped' : 'unknown';
      return;
    }
    const policy = world.pick(POLICIES);
    const done = await this.#d.memory.run(b.user, ({ engine }, range) =>
      engine.mergeBranch(range, { scope, name: b.name, policy }, { principal: 'sim', requestId }),
    );
    if (!done.ok) {
      b.status = 'unknown';
      return;
    }
    if (!done.value.merged) return; // abort found contradictions: still open
    b.status = 'merged';
    b.added = new Set(done.value.added);
    for (const id of done.value.added) this.#d.memory.remembered.get(b.user)?.add(id);
    for (const id of b.forgot) this.#d.memory.forgotten.add(id);
  }

  /** After healing, on each user's leader. */
  async check(): Promise<void> {
    let merged = 0;
    for (const b of this.#branches) {
      const at = this.#d.memory.leader(b.user);
      if (!at) continue; // MemoryLoad reports a missing leader
      const main = new MemoryReads(at.range.reader, TENANT, b.user);
      const meta = await main.branch(b.name);
      if (b.status !== 'unknown' && meta?.status !== b.status)
        this.#d.violate(
          `branch ${b.user}/${b.name}: status ${meta?.status ?? 'none'}, acknowledged ${b.status}`,
        );
      for (const id of b.memories) {
        const r = await main.record(id);
        const shouldBe = b.status === 'merged' && b.added.has(id);
        if (b.status !== 'unknown' && Boolean(r) !== shouldBe)
          this.#d.violate(
            `branch ${b.user}/${b.name}: memory ${id} ${r ? 'is' : 'is not'} on main (${b.status})`,
          );
      }
      if (b.status === 'open') {
        const seen = await at.n.engine.list(
          at.range,
          { tenant: TENANT, user: b.user },
          { limit: 1000, branch: b.name },
        );
        const ids = new Set(seen.ok ? seen.value.memories.map((m) => m.id) : []);
        for (const id of b.memories)
          if (!ids.has(id)) this.#d.violate(`branch ${b.user}/${b.name}: own ${id} not visible`);
        for (const id of b.forgot) {
          const masked = seen.ok && seen.value.memories.find((m) => m.id === id);
          if (masked && masked.expiredAtMs === undefined)
            this.#d.violate(`branch ${b.user}/${b.name}: forgot ${id} but still sees it`);
        }
      }
      if (b.status === 'merged') merged++;
    }
    this.#d.say(`branches: ${String(this.#branches.length)} created, ${String(merged)} merged`);
  }
}
