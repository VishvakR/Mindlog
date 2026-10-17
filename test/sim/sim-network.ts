import { clone } from '@bufbuild/protobuf';
import type { ClockSync, Hlc } from '@mindlog/core';
import type { NodeInboundHandler, NodeTransport } from '@mindlog/multiraft';
import type { KeyValue, Message } from '@mindlog/proto';
import { MessageSchema } from '@mindlog/proto';
import type { World } from './world.js';

export interface NetworkFaults {
  /** Probability that a message is lost. */
  drop: number;
  /** Probability that a delivered message arrives twice. */
  duplicate: number;
  /** One-way latency range in ms; overlapping ranges reorder messages. */
  latency: readonly [number, number];
}

/**
 * The simulated network (PLAN 22.2): latency, loss, duplication, reordering
 * and partitions, all drawn from the world's random source. Messages are
 * copied on the way, as if serialized.
 */
export class SimNetwork {
  readonly faults: NetworkFaults = { drop: 0, duplicate: 0, latency: [1, 5] };
  readonly #world: World;
  readonly #handlers = new Map<bigint, NodeInboundHandler>();
  readonly #clocks = new Map<bigint, ClockSync>();
  /** Partition group per node; nodes in different groups cannot talk. */
  #groups = new Map<bigint, number>();

  constructor(world: World) {
    this.#world = world;
  }

  /** The node's transport; node `n` is reached at address `n<n>`. */
  transport(id: bigint, sync: ClockSync): NodeTransport {
    return {
      attach: (handler) => {
        this.#handlers.set(id, handler);
        this.#clocks.set(id, sync);
      },
      send: (address, messages) => {
        const hlc = sync.stamp();
        for (const m of messages) this.#deliver(id, nodeOf(address), m, hlc);
      },
      sendSnapshot: async (
        address: string,
        message: Message,
        chunks: AsyncIterable<KeyValue[]>,
      ) => {
        const to = nodeOf(address);
        const pairs: KeyValue[] = [];
        for await (const chunk of chunks) pairs.push(...chunk);
        if (!this.#connected(id, to) || this.#world.chance(this.faults.drop)) return false;
        const copy = clone(MessageSchema, message);
        const hlc = sync.stamp();
        this.#world.at(this.#world.now + this.#latency(), () => {
          this.#clocks.get(to)?.receive(`n${id}`, hlc);
          this.#handlers.get(to)?.onSnapshot(copy, pairs);
        });
        return true;
      },
    };
  }

  /** The node is down: nothing reaches it until it attaches again. */
  detach(id: bigint): void {
    this.#handlers.delete(id);
    this.#clocks.delete(id);
  }

  partition(groups: ReadonlyArray<readonly bigint[]>): void {
    this.#groups = new Map(groups.flatMap((g, i) => g.map((id) => [id, i] as const)));
  }

  heal(): void {
    this.#groups.clear();
  }

  #connected(a: bigint, b: bigint): boolean {
    return (this.#groups.get(a) ?? -1) === (this.#groups.get(b) ?? -1);
  }

  #latency(): number {
    const [lo, hi] = this.faults.latency;
    return this.#world.between(lo, hi);
  }

  #deliver(from: bigint, to: bigint, m: Message, hlc: Hlc): void {
    const world = this.#world;
    if (!this.#connected(from, to) || world.chance(this.faults.drop)) return;
    const copies = world.chance(this.faults.duplicate) ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const copy = clone(MessageSchema, m);
      world.at(world.now + this.#latency(), () => {
        // Checked again on arrival: a partition may have started in flight.
        if (!this.#connected(from, to)) return;
        this.#clocks.get(to)?.receive(`n${from}`, hlc);
        this.#handlers.get(to)?.onMessages([copy], `n${from}`);
      });
    }
  }
}

const nodeOf = (address: string): bigint => BigInt(address.slice(1));
