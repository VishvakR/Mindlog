import { createSecureServer, createServer } from 'node:http2';
import type { Http2SecureServer, Http2Server, ServerHttp2Session } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { create } from '@bufbuild/protobuf';
import type { Client, ConnectRouter, ServiceImpl } from '@connectrpc/connect';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { connectNodeAdapter, createGrpcTransport } from '@connectrpc/connect-node';
import type { MindlogError, Result, TlsProvider } from '@mindlog/core';
import {
  ERROR_CODES,
  MindlogErrorCode,
  err,
  grpcClientOptions,
  mindlogError,
  mutualServerTls,
  ok,
} from '@mindlog/core';
import type { PdClient } from '@mindlog/multiraft';
import type {
  AdminRequest,
  ClusterResponse,
  RangeDescriptor,
  RangeHeartbeatResponse,
  RangeStats,
  StoreHeartbeatResponse,
  StoreStats,
} from '@mindlog/proto';
import {
  AllocIdsResponseSchema,
  PdService as PdRpc,
  ScanRangesResponseSchema,
  TsoResponseSchema,
} from '@mindlog/proto';
import type { PdService } from './pd-service.js';

const CODE_HEADER = 'x-mindlog-code';

/** gRPC status numbers are Connect's codes. */
const CONNECT_CODES = new Map<number, Code>(
  Object.values(Code)
    .filter((c): c is Code => typeof c === 'number')
    .map((c) => [c, c]),
);

function toConnect(error: MindlogError): ConnectError {
  const status = CONNECT_CODES.get(ERROR_CODES[error.code].grpcStatus) ?? Code.Unknown;
  const headers = new Headers({ [CODE_HEADER]: error.code });
  for (const [k, v] of Object.entries(error.fields ?? {})) headers.set(`x-mindlog-field-${k}`, v);
  return new ConnectError(error.message, status, headers);
}

const KNOWN = new Set<string>(Object.values(MindlogErrorCode));

function fromConnect(cause: unknown): MindlogError {
  const e = ConnectError.from(cause);
  const code = e.metadata.get(CODE_HEADER) ?? '';
  const fields: Record<string, string> = {};
  e.metadata.forEach((value, key) => {
    if (key.startsWith('x-mindlog-field-')) fields[key.slice('x-mindlog-field-'.length)] = value;
  });
  const known = KNOWN.has(code) ? (code as MindlogErrorCode) : 'UNAVAILABLE';
  return mindlogError(known, e.rawMessage, {
    retryAfterMs: 100,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  });
}

const unwrap = <T>(r: Result<T, MindlogError>): T => {
  if (!r.ok) throw toConnect(r.error);
  return r.value;
};

export interface PdServerOptions {
  readonly host: string;
  readonly port: number;
  readonly tls?: TlsProvider;
}

export interface PdServer {
  readonly address: AddressInfo;
  close(): Promise<void>;
}

function pdHandlers(get: () => PdService): ServiceImpl<typeof PdRpc> {
  return {
    allocIds: async (req) =>
      create(AllocIdsResponseSchema, { first: unwrap(await get().allocIds(req.count)) }),
    tso: async (req) => create(TsoResponseSchema, { last: unwrap(await get().tso(req.count)) }),
    getRange: async (req) => unwrap(await get().getRange(req.key)),
    scanRanges: async (req) =>
      create(ScanRangesResponseSchema, {
        ranges: unwrap(await get().scanRanges(req.startKey, req.limit)),
      }),
    storeHeartbeat: async (req) => {
      if (!req.stats) throw new ConnectError('no stats', Code.InvalidArgument);
      return unwrap(await get().storeHeartbeat(req.stats));
    },
    rangeHeartbeat: async (req) => {
      if (!req.stats) throw new ConnectError('no stats', Code.InvalidArgument);
      return unwrap(await get().rangeHeartbeat(req.stats));
    },
    cluster: async () => unwrap(await get().cluster()),
    admin: async (req) => ({
      $typeName: 'mindlog.v1.AdminResponse' as const,
      message: unwrap(await get().admin(req)),
    }),
  };
}

/** Mounts `PdService` on a Connect router: the PD role serves it next to the PD group's Raft service. */
export function pdRoutes(get: () => PdService): (router: ConnectRouter) => void {
  return (router) => {
    router.service(PdRpc, pdHandlers(get));
  };
}

/** Serves `PdService` over Connect (gRPC on HTTP/2) on `pd.listen` (port 7100). */
export async function startPdServer(
  service: PdService,
  options: PdServerOptions,
): Promise<PdServer> {
  const handler = connectNodeAdapter({
    routes: (router) => {
      router.service(
        PdRpc,
        pdHandlers(() => service),
      );
    },
  });
  const { tls } = options;
  const server: Http2Server | Http2SecureServer = tls
    ? createSecureServer(mutualServerTls(tls.identity()), handler)
    : createServer(handler);
  const stopTls = tls?.subscribe((i) => {
    (server as Http2SecureServer).setSecureContext(mutualServerTls(i));
  });
  const sessions = new Set<ServerHttp2Session>();
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    address: server.address() as AddressInfo,
    close: () =>
      new Promise<void>((resolve) => {
        stopTls?.();
        server.close(() => {
          resolve();
        });
        for (const session of sessions) session.destroy();
      }),
  };
}

/** A client of PD in the same process (single-node mode and tests). */
export class InProcessPdClient implements PdClient {
  readonly #service: PdService;

  constructor(service: PdService) {
    this.#service = service;
  }

  allocIds = (count: number) => this.#service.allocIds(count);
  tso = (count: number) => this.#service.tso(count);
  async getRange(key: Uint8Array) {
    const r = await this.#service.getRange(key);
    return r.ok && r.value.range
      ? ok({ range: r.value.range, leaderReplicaId: r.value.leaderReplicaId })
      : err(r.ok ? mindlogError('NOT_FOUND', 'no range') : r.error);
  }
  scanRanges = (start: Uint8Array, limit: number) => this.#service.scanRanges(start, limit);
  storeHeartbeat = (stats: StoreStats) => this.#service.storeHeartbeat(stats);
  rangeHeartbeat = (stats: RangeStats) => this.#service.rangeHeartbeat(stats);
  cluster = () => this.#service.cluster();
  admin = (request: AdminRequest) => this.#service.admin(request);
}

/**
 * A client of PD over Connect. It knows every PD endpoint, sends to the one
 * that last answered, and tries the others on `NOT_LEADER` or a connection
 * failure, so it finds the leader without being told who it is.
 */
export class ConnectPdClient implements PdClient {
  #clients: Array<Client<typeof PdRpc>>;
  #preferred = 0;

  constructor(endpoints: readonly string[], tls?: TlsProvider) {
    const connect = () =>
      endpoints.map((address) =>
        createClient(PdRpc, createGrpcTransport(grpcClientOptions(address, tls))),
      );
    this.#clients = connect();
    tls?.subscribe(() => {
      this.#clients = connect();
    });
  }

  async #call<T>(
    call: (client: Client<typeof PdRpc>) => Promise<T>,
  ): Promise<Result<T, MindlogError>> {
    let last: MindlogError = mindlogError(
      'UNAVAILABLE',
      'no placement driver endpoint is configured',
    );
    for (let i = 0; i < this.#clients.length; i++) {
      const index = (this.#preferred + i) % this.#clients.length;
      const client = this.#clients[index];
      if (!client) continue;
      try {
        const value = await call(client);
        this.#preferred = index;
        return ok(value);
      } catch (cause: unknown) {
        last = fromConnect(cause);
        if (last.code !== 'NOT_LEADER' && last.code !== 'UNAVAILABLE') return err(last);
      }
    }
    return err(last);
  }

  async allocIds(count: number) {
    const r = await this.#call((c) => c.allocIds({ count }));
    return r.ok ? ok(r.value.first) : r;
  }

  async tso(count: number) {
    const r = await this.#call((c) => c.tso({ count }));
    return r.ok ? ok(r.value.last) : r;
  }

  async getRange(key: Uint8Array) {
    const r = await this.#call((c) => c.getRange({ key }));
    if (!r.ok) return r;
    return r.value.range
      ? ok({ range: r.value.range, leaderReplicaId: r.value.leaderReplicaId })
      : err(mindlogError('NOT_FOUND', 'no range'));
  }

  async scanRanges(
    start: Uint8Array,
    limit: number,
  ): Promise<Result<RangeDescriptor[], MindlogError>> {
    const r = await this.#call((c) => c.scanRanges({ startKey: start, limit }));
    return r.ok ? ok(r.value.ranges) : r;
  }

  storeHeartbeat(stats: StoreStats): Promise<Result<StoreHeartbeatResponse, MindlogError>> {
    return this.#call((c) => c.storeHeartbeat({ stats }));
  }

  rangeHeartbeat(stats: RangeStats): Promise<Result<RangeHeartbeatResponse, MindlogError>> {
    return this.#call((c) => c.rangeHeartbeat({ stats }));
  }

  async cluster(): Promise<Result<ClusterResponse, MindlogError>> {
    return this.#call((c) => c.cluster({}));
  }

  async admin(request: AdminRequest): Promise<Result<string, MindlogError>> {
    const r = await this.#call((c) => c.admin(request));
    return r.ok ? ok(r.value.message) : r;
  }
}
