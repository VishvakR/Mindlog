import { createServer } from 'node:http2';
import type { Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { Client } from '@connectrpc/connect';
import { createClient } from '@connectrpc/connect';
import {
  Http2SessionManager,
  connectNodeAdapter,
  createGrpcTransport,
} from '@connectrpc/connect-node';
import type { Counter, Logger, Metrics } from '@mindlog/core';
import type { InboundHandler, RaftTransport } from '@mindlog/multiraft';
import type { KeyValue, Message, SendRequest, SnapshotRequest } from '@mindlog/proto';
import { RaftService } from '@mindlog/proto';
import { AsyncQueue } from './async-queue.js';

export interface ConnectTransportOptions {
  readonly host: string;
  /** 0 binds any free port. */
  readonly port: number;
  /** Batches waiting per peer before new ones are dropped. */
  readonly maxQueuedBatches?: number;
  /** Wait before reopening a broken stream. */
  readonly reconnectMs?: number;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

interface Peer {
  readonly address: string;
  readonly sessions: Http2SessionManager;
  readonly client: Client<typeof RaftService>;
  queue: AsyncQueue<SendRequest> | undefined;
  retryAt: number;
}

/**
 * Raft transport over Connect's gRPC protocol on HTTP/2 (ADR-0025): one
 * long-lived client stream per peer carrying one batch per Ready, and a
 * separate stream per snapshot. Best effort, like Raft itself.
 */
export class ConnectTransport implements RaftTransport {
  readonly #options: ConnectTransportOptions;
  readonly #server: Http2Server;
  readonly #peers = new Map<bigint, Peer>();
  readonly #dropped: Counter;
  readonly #sent: Counter;
  readonly #inbound: { handler?: InboundHandler };

  private constructor(
    options: ConnectTransportOptions,
    server: Http2Server,
    inbound: { handler?: InboundHandler },
  ) {
    this.#options = options;
    this.#server = server;
    this.#inbound = inbound;
    this.#dropped = options.metrics.counter({
      name: 'mindlog_transport_dropped_messages_total',
      help: 'Raft messages dropped because a peer queue was full or unreachable',
    });
    this.#sent = options.metrics.counter({
      name: 'mindlog_transport_sent_messages_total',
      help: 'Raft messages handed to a peer stream',
    });
  }

  /** Starts the server side on the internal listener. */
  static async start(options: ConnectTransportOptions): Promise<ConnectTransport> {
    const inbound: { handler?: InboundHandler } = {};
    const server = createServer(
      connectNodeAdapter({
        routes: (router) => {
          router.service(RaftService, {
            send: async (requests: AsyncIterable<SendRequest>) => {
              for await (const request of requests) inbound.handler?.onMessages(request.messages);
              return {};
            },
            snapshot: async (requests: AsyncIterable<SnapshotRequest>) => {
              let message: Message | undefined;
              const pairs: KeyValue[] = [];
              for await (const request of requests) {
                message ??= request.message;
                pairs.push(...request.pairs);
              }
              if (message) inbound.handler?.onSnapshot(message, pairs);
              return {};
            },
          });
        },
      }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return new ConnectTransport(options, server, inbound);
  }

  get address(): AddressInfo {
    return this.#server.address() as AddressInfo;
  }

  attach(handler: InboundHandler): void {
    this.#inbound.handler = handler;
  }

  setPeers(addresses: ReadonlyMap<bigint, string>): void {
    for (const [id, peer] of this.#peers) {
      if (addresses.get(id) === peer.address) continue;
      this.#closePeer(peer);
      this.#peers.delete(id);
    }
    for (const [id, address] of addresses) {
      if (this.#peers.has(id) || !address) continue;
      const baseUrl = `http://${address}`;
      const sessions = new Http2SessionManager(baseUrl);
      const client = createClient(
        RaftService,
        createGrpcTransport({ baseUrl, sessionManager: sessions }),
      );
      this.#peers.set(id, { address, sessions, client, queue: undefined, retryAt: 0 });
    }
  }

  send(messages: readonly Message[]): void {
    const byPeer = new Map<bigint, Message[]>();
    for (const m of messages) {
      const list = byPeer.get(m.to) ?? [];
      list.push(m);
      byPeer.set(m.to, list);
    }
    for (const [id, batch] of byPeer) {
      const peer = this.#peers.get(id);
      const queue = peer ? this.#stream(id, peer) : undefined;
      if (queue?.push({ $typeName: 'mindlog.v1.SendRequest', messages: batch }))
        this.#sent.inc(batch.length);
      else this.#dropped.inc(batch.length);
    }
  }

  async sendSnapshot(message: Message, chunks: AsyncIterable<KeyValue[]>): Promise<boolean> {
    const peer = this.#peers.get(message.to);
    if (!peer) return false;
    async function* body(): AsyncIterable<SnapshotRequest> {
      yield { $typeName: 'mindlog.v1.SnapshotRequest', message, pairs: [] };
      for await (const pairs of chunks) yield { $typeName: 'mindlog.v1.SnapshotRequest', pairs };
    }
    try {
      await peer.client.snapshot(body());
      return true;
    } catch (cause: unknown) {
      this.#options.logger.warn('snapshot stream failed', { to: message.to, error: String(cause) });
      return false;
    }
  }

  async close(): Promise<void> {
    for (const peer of this.#peers.values()) this.#closePeer(peer);
    this.#peers.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  /** The peer's open stream, opening one unless it recently failed. */
  #stream(id: bigint, peer: Peer): AsyncQueue<SendRequest> | undefined {
    if (peer.queue) return peer.queue;
    if (Date.now() < peer.retryAt) return undefined;
    const queue = new AsyncQueue<SendRequest>(this.#options.maxQueuedBatches ?? 1024);
    peer.queue = queue;
    peer.client.send(queue).then(
      () => {
        if (peer.queue === queue) peer.queue = undefined;
      },
      (cause: unknown) => {
        if (peer.queue === queue) peer.queue = undefined;
        queue.close();
        peer.retryAt = Date.now() + (this.#options.reconnectMs ?? 200);
        this.#options.logger.debug('raft stream to peer broke', { to: id, error: String(cause) });
        this.#inbound.handler?.onUnreachable(id);
      },
    );
    return queue;
  }

  #closePeer(peer: Peer): void {
    peer.queue?.close();
    peer.queue = undefined;
    peer.sessions.abort();
  }
}
