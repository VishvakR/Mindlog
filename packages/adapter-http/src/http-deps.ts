import type {
  ConnectionCommandRegistry,
  ConnectionLimits,
  ServerContext,
} from '@mindlog/adapter-resp';
import type { Clock, Logger, Metrics, Tracer } from '@mindlog/core';
import type {
  AccessControl,
  AdminService,
  TenantGovernor,
  TenantService,
  ApiKeyService,
  ChangeFeed,
  ClusterDirectory,
  KvBrowser,
  KvService,
  MemoryService,
  AppAuthService,
  CollectionService,
  RecordBroker,
  RecordFiles,
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
  /** The tenant registry (PLAN 18.3). */
  readonly tenants: TenantService;
  /** Per-tenant quotas and usage (PLAN 18.3); absent on harnesses without them. */
  readonly governor?: TenantGovernor;
  /** The application-layer authorization check (PLAN 18.2). */
  readonly access: AccessControl;
  readonly kv: KvService;
  readonly browser: KvBrowser;
  /** The placement driver's view of the cluster, for the Cluster page. */
  readonly cluster: ClusterDirectory;
  /** Memory operations (PLAN 15.3); absent on nodes without a memory engine. */
  readonly memory?: MemoryService;
  /** Full-stack collections and records (PLAN 16); absent turns those routes off. */
  readonly collections?: CollectionService;
  /** Realtime record subscriptions (PLAN 16.6). */
  readonly broker?: RecordBroker;
  /** Record files (PLAN 16.5); absent turns uploads off. */
  readonly files?: RecordFiles;
  /** End-user auth of auth collections (ADR-0035). */
  readonly appAuth?: AppAuthService;
  /** Auth requests per client address (default 20, then 30 a minute). */
  readonly authRateLimit?: { readonly burst: number; readonly perMinute: number };
  /** Tenant of full-stack requests that name none. */
  readonly defaultTenant?: string;
  /** The memory change stream `/api/realtime` serves (PLAN 13.5). */
  readonly changes?: ChangeFeed;
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
