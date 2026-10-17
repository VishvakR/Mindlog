import { create } from '@bufbuild/protobuf';
import { MemoryLogger, MemoryMetrics, SeededRandom, SystemClock, encodeKey } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import type { KeyValue, Message, RangeDescriptor } from '@mindlog/proto';
import { RangeDescriptorSchema } from '@mindlog/proto';
import type {
  NodeInboundHandler,
  NodeTransport,
  ReplicaOptions,
  Scheduler,
} from '@mindlog/multiraft';
import { Replica, Store, SystemScheduler } from '@mindlog/multiraft';
import type { KvStore } from '@mindlog/storage';
import { GroupCommitStore, MemoryStore } from '@mindlog/storage';
import { ApplyHandlerRegistry, RaftLogStore, StateMachine } from '@mindlog/statemachine';
import { counterHandler } from './counter.js';
import { FAST } from './local-cluster.js';

/** In-memory node network: async delivery between node addresses, cuttable links. */
export class NodeNetwork {
  readonly handlers = new Map<string, NodeInboundHandler>();
  readonly cut = new Set<string>();

  transport(self: string): NodeTransport {
    return {
      attach: (handler) => {
        this.handlers.set(self, handler);
      },
      send: (address: string, messages: readonly Message[]) => {
        if (this.cut.has(`${self}>${address}`)) return;
        setImmediate(() => this.handlers.get(address)?.onMessages(messages, self));
      },
      sendSnapshot: async (
        address: string,
        message: Message,
        chunks: AsyncIterable<KeyValue[]>,
      ) => {
        const pairs: KeyValue[] = [];
        for await (const chunk of chunks) pairs.push(...chunk);
        if (this.cut.has(`${self}>${address}`)) return false;
        this.handlers.get(address)?.onSnapshot(message, pairs);
        return true;
      },
    };
  }

  isolate(address: string, others: readonly string[]): void {
    for (const other of others) {
      if (other === address) continue;
      this.cut.add(`${address}>${other}`);
      this.cut.add(`${other}>${address}`);
    }
  }
}

const key = (name: string): Uint8Array => {
  const r = encodeKey({ tenant: 't', family: 'k', tuple: [name] });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

/** Range 1 covers keys below `m`, range 2 the rest. */
export const SPANS: Record<string, RangeDescriptor> = {
  '1': create(RangeDescriptorSchema, { rangeId: 1n, endKey: key('m') }),
  '2': create(RangeDescriptorSchema, { rangeId: 2n, startKey: key('m') }),
};

/** A real scheduler that counts the timers it starts. */
export class CountingScheduler implements Scheduler {
  timers = 0;
  readonly #inner = new SystemScheduler();
  every(ms: number, fn: () => void): () => void {
    this.timers++;
    return this.#inner.every(ms, fn);
  }
  defer(fn: () => void): void {
    this.#inner.defer(fn);
  }
}

export interface StoreNode {
  readonly id: bigint;
  readonly address: string;
  readonly store: Store;
  readonly stateStore: KvStore;
  readonly scheduler: CountingScheduler;
}

/**
 * Nodes that each run one `Store` over shared log and state stores. Ranges in
 * `bootstrap[node]` start there with every node of `members` as a voter;
 * other ranges appear when a message for them arrives.
 */
export async function storeCluster(
  ids: readonly bigint[],
  bootstrap: Record<string, readonly bigint[]>,
  options: Partial<ReplicaOptions> = {},
) {
  const net = new NodeNetwork();
  const nodes = new Map<bigint, StoreNode>();
  const address = (id: bigint) => `n${id}`;
  const peers = ids.map((id) => ({ id, address: address(id) }));

  for (const id of ids) {
    const logger = new MemoryLogger();
    const metrics = new MemoryMetrics();
    const logStore = new GroupCommitStore(new MemoryStore());
    const stateStore = new MemoryStore();
    const scheduler = new CountingScheduler();
    const starting = new Set(bootstrap[String(id)] ?? []);
    const store = Store.start({
      nodeId: id,
      transport: net.transport(address(id)),
      scheduler,
      clock: new SystemClock(),
      logger,
      tickMs: FAST.tickMs,
      electionTicks: FAST.electionTicks[0],
      openReplica: async (rangeId, views) => {
        const handlers = new ApplyHandlerRegistry();
        handlers.register(counterHandler);
        const descriptor = starting.has(rangeId) ? SPANS[String(rangeId)] : undefined;
        const machine = await StateMachine.open({
          store: stateStore,
          handlers,
          events: new InMemoryEventBus({ logger, metrics }),
          clock: new SystemClock(),
          logger,
          metrics,
          rangeId,
          ...(descriptor ? { descriptor } : {}),
        });
        return Replica.open({
          rangeId,
          raftId: id,
          options: { ...FAST, ...options },
          log: new RaftLogStore(logStore, rangeId),
          machine,
          transport: views.transport,
          scheduler: views.scheduler,
          clock: new SystemClock(),
          random: new SeededRandom(id * 100n + rangeId),
          logger,
          metrics,
          ...(starting.has(rangeId) ? { bootstrap: peers } : {}),
        });
      },
    });
    for (const rangeId of starting) await store.addRange(rangeId);
    nodes.set(id, { id, address: address(id), store, stateStore, scheduler });
  }

  const node = (id: bigint): StoreNode => {
    const n = nodes.get(id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  };
  return {
    net,
    nodes,
    node,
    replica: (id: bigint, rangeId: bigint) => node(id).store.replica(rangeId),
    leader: (rangeId: bigint) =>
      [...nodes.values()].find((n) => n.store.replica(rangeId)?.isLeader()),
    close: async () => {
      for (const n of nodes.values()) await n.store.close();
    },
  };
}
