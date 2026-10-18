import { createServer } from 'node:http2';
import type { Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { Client, ConnectRouter } from '@connectrpc/connect';
import { createClient } from '@connectrpc/connect';
import {
  Http2SessionManager,
  connectNodeAdapter,
  createGrpcTransport,
} from '@connectrpc/connect-node';
import type { ClockSync, Counter, Hlc, Logger, Metrics } from '@mindlog/core';
import type { NodeInboundHandler, NodeTransport } from '@mindlog/multiraft';
import type { KeyValue, Message, SendRequest, SnapshotRequest } from '@mindlog/proto';
import { RaftService } from '@mindlog/proto';
import { AsyncQueue } from './async-queue.js';

export interface ConnectTransportOptions {
  readonly host: string;
  /** 0 binds any free port. */
  readonly port: number;
  /** Address peers reach this node at; defaults to host:boundPort. */
  readonly advertise?: string;
  /** Batches waiting per peer before new ones are dropped. */
  readonly maxQueuedBatches?: number;
  /** Wait before reopening a broken stream. */
  readonly reconnectMs?: number;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Stamps outgoing RPCs with the node's HLC and merges incoming ones (PLAN 8.7). */
  readonly clock?: ClockSync;
  /** More Connect services to serve on this listener (the placement driver's RPCs). */
  readonly routes?: (router: ConnectRouter) => void;
}

interface Peer {
  readonly address: string;
  readonly sessions: Http2SessionManager;
  readonly client: Client<typeof RaftService>;
  queue: AsyncQueue<SendRequest> | undefined;
  retryAt: number;
}

/**
 * Node transport over Connect's gRPC protocol on HTTP/2 (ADR-0025, ADR-0028):
 * one long-lived client stream per peer node carrying the messages of all
 * ranges, one batch per send, and a separate stream per snapshot. Best
 * effort, like Raft itself.
 */
export class ConnectTransport implements NodeTransport {
  readonly #options: ConnectTransportOptions;
  readonly #server: Http2Server;
  readonly #peers = new Map<string, Peer>();
  readonly #self: string;
  readonly #dropped: Counter;
  readonly #sent: Counter;
  readonly #inbound: { handler?: NodeInboundHandler };

  private constructor(
    options: ConnectTransportOptions,
    server: Http2Server,
    inbound: { handler?: NodeInboundHandler },
  ) {
    this.#options = options;
    this.#server = server;
    this.#inbound = inbound;
    const bound = server.address() as AddressInfo;
    this.#self = options.advertise ?? `${options.host}:${String(bound.port)}`;
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
    const inbound: { handler?: NodeInboundHandler } = {};
    const server = createServer(
      connectNodeAdapter({
        routes: (router) => {
          options.routes?.(router);
          router.service(RaftService, {
            send: async (requests: AsyncIterable<SendRequest>) => {
              for await (const request of requests) {
                options.clock?.receive(request.fromAddress, request.hlc as Hlc);
                inbound.handler?.onMessages(request.messages, request.fromAddress);
              }
              return {};
            },
            snapshot: async (requests: AsyncIterable<SnapshotRequest>) => {
              let message: Message | undefined;
              const pairs: KeyValue[] = [];
              for await (const request of requests) {
                if (request.hlc !== 0n)
                  options.clock?.receive(request.fromAddress, request.hlc as Hlc);
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

  /** The address this node advertises to its peers. */
  get self(): string {
    return this.#self;
  }

  attach(handler: NodeInboundHandler): void {
    this.#inbound.handler = handler;
  }

  send(address: string, messages: readonly Message[]): void {
    const queue = this.#stream(this.#peer(address));
    const request: SendRequest = {
      $typeName: 'mindlog.v1.SendRequest',
      messages: [...messages],
      fromAddress: this.#self,
      hlc: this.#options.clock?.stamp() ?? 0n,
    };
    if (queue?.push(request)) this.#sent.inc(messages.length);
    else this.#dropped.inc(messages.length);
  }

  async sendSnapshot(
    address: string,
    message: Message,
    chunks: AsyncIterable<KeyValue[]>,
  ): Promise<boolean> {
    const peer = this.#peer(address);
    const clock = this.#options.clock;
    const self = this.#self;
    async function* body(): AsyncIterable<SnapshotRequest> {
      yield {
        $typeName: 'mindlog.v1.SnapshotRequest',
        message,
        pairs: [],
        hlc: clock?.stamp() ?? 0n,
        fromAddress: self,
      };
      for await (const pairs of chunks)
        yield { $typeName: 'mindlog.v1.SnapshotRequest', pairs, hlc: 0n, fromAddress: '' };
    }
    try {
      await peer.client.snapshot(body());
      return true;
    } catch (cause: unknown) {
      this.#options.logger.warn('snapshot stream failed', { to: address, error: String(cause) });
      return false;
    }
  }

  /** The client for a peer node, created on first use. */
  #peer(address: string): Peer {
    let peer = this.#peers.get(address);
    if (!peer) {
      const baseUrl = `http://${address}`;
      const sessions = new Http2SessionManager(baseUrl);
      const client = createClient(
        RaftService,
        createGrpcTransport({ baseUrl, sessionManager: sessions }),
      );
      peer = { address, sessions, client, queue: undefined, retryAt: 0 };
      this.#peers.set(address, peer);
    }
    return peer;
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
  #stream(peer: Peer): AsyncQueue<SendRequest> | undefined {
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
        this.#options.logger.debug('raft stream to peer broke', {
          to: peer.address,
          error: String(cause),
        });
        this.#inbound.handler?.onUnreachable(peer.address);
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
