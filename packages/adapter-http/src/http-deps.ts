import type {
  ConnectionCommandRegistry,
  ConnectionLimits,
  ServerContext,
} from '@mindlog/adapter-resp';
import type { Clock, Logger, Metrics, Tracer } from '@mindlog/core';
import type {
  AdminService,
  ApiKeyService,
  ClusterDirectory,
  KvBrowser,
  KvService,
  MemoryService,
} from '@mindlog/services';

export interface HttpServerOptions {
  readonly host: string;
  /** 0 picks a free port. */
  readonly port: number;
  /** Largest accepted request body. */
  readonly bodyLimit: number;
}

export interface HttpServerDeps {
  readonly admin: AdminService;
  /** API keys for MCP agents; absent on nodes without them. */
  readonly apiKeys?: ApiKeyService;
  readonly kv: KvService;
  readonly browser: KvBrowser;
  /** The placement driver's view of the cluster, for the Cluster page. */
  readonly cluster: ClusterDirectory;
  /** Memory operations (PLAN 15.3); absent on nodes without a memory engine. */
  readonly memory?: MemoryService;
  /** What the WebSocket console needs to run RESP connections. */
  readonly resp: {
    readonly server: ServerContext;
    readonly handlers: ConnectionCommandRegistry;
    readonly limits: ConnectionLimits;
  };
  readonly prometheus: { render(): Promise<string>; readonly contentType: string };
  readonly metrics: Metrics;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly version: string;
  /** True once recovery finished and the listeners are up. */
  readonly ready: () => boolean;
  readonly overview: () => Promise<Record<string, unknown>>;
  /** Effective configuration with secrets redacted. */
  readonly settings: () => Record<string, unknown>;
  /** Built dashboard assets; `/_/` explains how to build them when missing. */
  readonly dashboardDir?: string;
  readonly options: HttpServerOptions;
}
