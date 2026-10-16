import { ManualClock, MemoryLogger, MemoryMetrics, SeededRandom, SystemClock } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import type { KeyValue, Message } from '@mindlog/proto';
import type { InboundHandler, RaftTransport, ReplicaOptions } from '@mindlog/multiraft';
import { Replica, SystemScheduler } from '@mindlog/multiraft';
import { DEFAULT_RAFT_OPTIONS } from '@mindlog/raft';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore } from '@mindlog/storage';
import { ApplyHandlerRegistry, RaftLogStore, StateMachine } from '@mindlog/statemachine';
import { counterHandler } from './counter.js';

export const FAST: ReplicaOptions = {
  ...DEFAULT_RAFT_OPTIONS,
  tickMs: 2,
  snapshotEntries: 10_000,
  trailingEntries: 10,
  snapshotChunkBytes: 1024,
  maxPendingProposals: 1000,
};

/** In-memory network: async delivery, cuttable links. */
export class LocalNetwork {
  readonly handlers = new Map<bigint, InboundHandler>();
  readonly cut = new Set<string>();

  transport(id: bigint): RaftTransport {
    return {
      attach: (handler) => {
        this.handlers.set(id, handler);
      },
      send: (messages: readonly Message[]) => {
        for (const m of messages) {
          if (this.cut.has(`${id}>${m.to}`)) continue;
          setImmediate(() => this.handlers.get(m.to)?.onMessages([m]));
        }
      },
      sendSnapshot: async (message: Message, chunks: AsyncIterable<KeyValue[]>) => {
        const pairs: KeyValue[] = [];
        for await (const chunk of chunks) pairs.push(...chunk);
        if (this.cut.has(`${id}>${message.to}`)) return false;
        this.handlers.get(message.to)?.onSnapshot(message, pairs);
        return true;
      },
      setPeers: () => {},
    };
  }

  isolate(id: bigint, ids: readonly bigint[]): void {
    for (const other of ids) {
      if (other === id) continue;
      this.cut.add(`${id}>${other}`);
      this.cut.add(`${other}>${id}`);
    }
  }
}

export interface ClusterNode {
  readonly id: bigint;
  replica: Replica;
  machine: StateMachine;
  readonly logStore: KvStore;
  readonly stateStore: KvStore;
}

/** A cluster of real Replicas over MemoryStores and the in-memory network. */
export async function localCluster(ids: readonly bigint[], options: Partial<ReplicaOptions> = {}) {
  const net = new LocalNetwork();
  const nodes = new Map<bigint, ClusterNode>();
  const bootstrap = ids.map((id) => ({ id, address: `n${id}` }));

  async function open(
    id: bigint,
    logStore: KvStore,
    stateStore: KvStore,
    joiner = false,
  ): Promise<ClusterNode> {
    const logger = new MemoryLogger();
    const metrics = new MemoryMetrics();
    const handlers = new ApplyHandlerRegistry();
    handlers.register(counterHandler);
    const machine = await StateMachine.open({
      store: stateStore,
      handlers,
      events: new InMemoryEventBus({ logger, metrics }),
      clock: new ManualClock(),
      logger,
      metrics,
    });
    const replica = await Replica.open({
      rangeId: 1n,
      raftId: id,
      options: { ...FAST, ...options },
      log: new RaftLogStore(logStore),
      machine,
      transport: net.transport(id),
      scheduler: new SystemScheduler(),
      clock: new SystemClock(),
      random: new SeededRandom(id),
      logger,
      metrics,
      ...(joiner ? {} : { bootstrap }),
    });
    replica.start();
    const node = { id, replica, machine, logStore, stateStore };
    nodes.set(id, node);
    return node;
  }

  for (const id of ids) await open(id, new MemoryStore(), new MemoryStore());

  return {
    net,
    nodes,
    node: (id: bigint): ClusterNode => {
      const n = nodes.get(id);
      if (!n) throw new Error(`no node ${id}`);
      return n;
    },
    addJoiner: (id: bigint) => open(id, new MemoryStore(), new MemoryStore(), true),
    /** Closes and reopens a node over its stores, like a process restart. */
    restart: async (id: bigint): Promise<ClusterNode> => {
      const n = nodes.get(id);
      if (!n) throw new Error(`no node ${id}`);
      await n.replica.close();
      return open(id, n.logStore, n.stateStore);
    },
    leader: (): ClusterNode | undefined => [...nodes.values()].find((n) => n.replica.isLeader()),
    close: async () => {
      for (const n of nodes.values()) await n.replica.close();
    },
  };
}

export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}
