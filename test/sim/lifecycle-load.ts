import { create } from '@bufbuild/protobuf';
import type { MemoryBlobStore } from '@mindlog/blob';
import { MemoryReads, decodeSegment, encodeSegment, stubText } from '@mindlog/memory';
import { TierMoveSchema } from '@mindlog/proto';
import type { MemoryLoad } from './memory-load.js';
import type { World } from './world.js';

const TENANT = 'default';
const enc = new TextEncoder();

export interface LifecycleLoadDeps {
  readonly world: World;
  readonly memory: MemoryLoad;
  /** The cold tier every node shares (an object store). */
  readonly blob: MemoryBlobStore;
  readonly say: (line: string) => void;
  readonly violate: (what: string) => void;
}

/**
 * The lifecycle workload (phase 8, ADR-0033): recalls and their stats, moves
 * to the cold tier and back, evolutions and pins, under the run's faults.
 * Replicas must end with the same state (the scenario's state hashes); every
 * cold memory must have a matching segment and no vector; tier counts must
 * add up; acknowledged evolutions keep their earlier versions.
 */
export class LifecycleLoad {
  readonly #d: LifecycleLoadDeps;
  #seq = 0;
  /** Acknowledged evolutions per memory. */
  readonly #evolved = new Map<string, number>();
  /** Acknowledged pins (the last acknowledged value). */
  readonly #pinned = new Map<string, boolean>();
  #cold = 0;
  #promoted = 0;
  /** Memories whose move to cold was acknowledged, by user. */
  readonly #cooled = new Map<string, string[]>();
  #recalls = 0;

  constructor(deps: LifecycleLoadDeps) {
    this.#d = deps;
  }

  /** Acknowledged operations, for the run's stats. */
  get counts() {
    return {
      recalls: this.#recalls,
      cooled: this.#cold,
      warmed: this.#promoted,
      evolved: this.#evolved.size,
      pinned: this.#pinned.size,
    };
  }

  #live(user: string): string[] {
    const m = this.#d.memory;
    return [...(m.remembered.get(user) ?? [])].filter((id) => !m.forgotten.has(id));
  }

  #pickUser(): string | undefined {
    const users = [...this.#d.memory.remembered.keys()].filter((u) => this.#live(u).length > 0);
    return users.length > 0 ? this.#d.world.pick(users) : undefined;
  }

  /** Recalls, then proposes their stats (normally every 2 s; here when the workload says). */
  async recall(): Promise<void> {
    const user = this.#pickUser();
    if (!user) return;
    const scope = { tenant: TENANT, user };
    const done = await this.#d.memory.run(user, async ({ engine }, range) => {
      const r = await engine.recall(
        range,
        { scope, query: 'Ana likes', includeCold: true },
        {
          principal: 'sim',
        },
      );
      await engine.flushRecallStats();
      return r;
    });
    if (done.ok) this.#recalls++;
  }

  /** Moves a few hot memories cold, the way the forgetting worker does. */
  async cool(): Promise<void> {
    const user = this.#pickUser();
    if (!user) return;
    const world = this.#d.world;
    const ids = [...new Set([world.pick(this.#live(user)), world.pick(this.#live(user))])];
    const seq = this.#seq++;
    const done = await this.#d.memory.run(user, async ({ engine }, range) => {
      const reads = new MemoryReads(range.reader, TENANT, user);
      const entries = [];
      for (const id of ids) {
        const record = await reads.record(id);
        if (!record || record.tier === 'cold' || record.expiredAt !== 0n || record.pinned) continue;
        const v = await reads.vector(id);
        entries.push({ record, vector: v?.vector ?? new Uint8Array(), modelId: v?.modelId ?? '' });
      }
      if (entries.length === 0) return { ok: true as const, value: { ids: [], count: 0 } };
      const seg = encodeSegment(TENANT, user, entries);
      const put = await this.#d.blob.put(seg.key, seg.bytes);
      if (!put.ok) return put;
      const moved = await engine.maintain(
        range,
        { tenant: TENANT, user },
        {
          tier: entries.map((e) =>
            create(TierMoveSchema, {
              id: e.record.id,
              tier: 'cold',
              segment: seg.key,
              sha256: seg.sha256,
              text: stubText(e.record.text),
            }),
          ),
        },
        { principal: 'sim', requestId: enc.encode(`sim-cool-${String(seq)}`) },
      );
      return moved;
    });
    if (!done.ok) return;
    this.#cold += done.value.count;
    this.#cooled.set(user, [...(this.#cooled.get(user) ?? []), ...done.value.ids]);
  }

  async warm(): Promise<void> {
    const users = [...this.#cooled.keys()];
    if (users.length === 0) return;
    const user = this.#d.world.pick(users);
    const live = new Set(this.#live(user));
    const cooled = (this.#cooled.get(user) ?? []).filter((id) => live.has(id));
    if (cooled.length === 0) return;
    const id = this.#d.world.pick(cooled);
    const seq = this.#seq++;
    const done = await this.#d.memory.run(user, ({ engine }, range) =>
      engine.promote(range, { tenant: TENANT, user }, [id], {
        principal: 'sim',
        requestId: enc.encode(`sim-warm-${String(seq)}`),
      }),
    );
    if (done.ok) this.#promoted += done.value.count;
  }

  async evolve(): Promise<void> {
    const user = this.#pickUser();
    if (!user) return;
    const world = this.#d.world;
    const id = world.pick(this.#live(user));
    const seq = this.#seq++;
    const pin = world.chance(1 / 3);
    const done = await this.#d.memory.run(user, ({ engine }, range) =>
      engine.maintain(
        range,
        { tenant: TENANT, user },
        pin
          ? { pin: [{ id, pinned: world.chance(1 / 2) }] }
          : { evolve: [{ id, tags: [`t${String(seq)}`], setTags: true }] },
        { principal: 'sim', requestId: enc.encode(`sim-evolve-${String(seq)}`) },
      ),
    );
    if (!done.ok || done.value.count === 0) return;
    if (pin) {
      // Read back what was acknowledged: the command's value.
      const at = this.#d.memory.leader(user);
      const r = at && (await new MemoryReads(at.range.reader, TENANT, user).record(id));
      if (r) this.#pinned.set(id, r.pinned);
    } else this.#evolved.set(id, (this.#evolved.get(id) ?? 0) + 1);
  }

  /** After healing, on each user's leader. */
  async check(): Promise<void> {
    for (const user of this.#d.memory.remembered.keys()) {
      const at = this.#d.memory.leader(user);
      if (!at) continue;
      const reads = new MemoryReads(at.range.reader, TENANT, user);
      let hot = 0;
      let cold = 0;
      for await (const r of reads.records()) {
        if (r.expiredAt !== 0n) continue;
        if (r.tier !== 'cold') {
          hot++;
          continue;
        }
        cold++;
        if (await reads.vector(r.id)) this.#d.violate(`${user}/${r.id}: cold with a vector`);
        const bytes = await this.#d.blob.get(r.coldSegment);
        const entries = bytes.ok && bytes.value && decodeSegment(bytes.value, r.coldSha256);
        if (!entries || !entries.some((e) => e.record.id === r.id))
          this.#d.violate(`${user}/${r.id}: cold segment ${r.coldSegment} missing or wrong`);
      }
      const s = await at.n.engine.lifecycle(at.range, { tenant: TENANT, user });
      if (s.hot !== hot || s.cold !== cold)
        this.#d.violate(
          `${user}: lifecycle counts ${String(s.hot)}/${String(s.cold)}, records ${String(hot)}/${String(cold)}`,
        );
      for (const [id, n] of this.#evolved) {
        if (!this.#d.memory.remembered.get(user)?.has(id)) continue;
        const kept = await reads.versions(id);
        if (kept.length < n)
          this.#d.violate(`${user}/${id}: ${String(n)} evolutions, ${String(kept.length)} kept`);
      }
    }
    this.#d.say(
      `lifecycle: ${String(this.#recalls)} recalls, ${String(this.#cold)} cooled, ${String(this.#promoted)} warmed, ${String(this.#evolved.size)} evolved`,
    );
  }
}
