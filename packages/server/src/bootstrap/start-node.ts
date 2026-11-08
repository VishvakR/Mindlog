import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { HttpServerOptions } from '@mindlog/adapter-http';
import { HttpServer } from '@mindlog/adapter-http';
import type { ConnectionLimits, ServerContext } from '@mindlog/adapter-resp';
import {
  ClientRegistry,
  CommandTable,
  RespServer,
  createConnectionCommands,
  loadCommandSpecs,
} from '@mindlog/adapter-resp';
import type { Clock, Logger, Metrics, MindlogConfig, MindlogError, Result } from '@mindlog/core';
import {
  OtelTracer,
  PromMetrics,
  SystemClock,
  createLogger,
  err,
  initTracing,
  ok,
} from '@mindlog/core';
import {
  AdminService,
  RecordBroker,
  RecordFiles,
  collectionWorkers,
  ensureCrons,
  ApiKeyService,
  ClusterDirectory,
  ClusterService,
  KvBrowser,
} from '@mindlog/services';
import { McpHttpServer } from '@mindlog/adapter-mcp';
import type { Replica } from '@mindlog/multiraft';
import type { HeldLock } from '@mindlog/txn';
import type { NodeCore } from './open-node-core.js';
import { openNodeCore } from './open-node-core.js';
import { RangeJobs } from './range-jobs.js';
import { openAppAuth } from './open-app-auth.js';
import { openBlobStore } from './open-memory.js';
import { sharpThumbnailer } from './sharp-thumbnailer.js';
import { runMigrations } from './run-migrations.js';
import { mindlogVersion, serverInfo } from './server-info.js';

export interface NodeOptions {
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly clock?: Clock;
  /** Built dashboard assets (default: `packages/server/dashboard`). */
  readonly dashboardDir?: string;
}

export interface RunningNode {
  readonly config: MindlogConfig;
  readonly resp: AddressInfo;
  readonly http: AddressInfo;
  /** MCP Streamable HTTP listener (PLAN 15.2). */
  readonly mcp: AddressInfo;
  /** API keys for agents; `mindlog-server apikey create` makes them offline. */
  readonly apiKeys: ApiKeyService;
  /** Internal Raft listener; absent for a single-voter node. */
  readonly internal: AddressInfo | undefined;
  readonly replica: Replica;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Dashboard superusers (ADR-0024). */
  readonly admin: AdminService;
  /** Log entries replayed into state at startup (ADR-0005). */
  readonly replayed: number;
  /** Stops accepting, finishes in-flight work, flushes state and closes the stores. */
  close(): Promise<void>;
}

/** Where `web/` builds the dashboard: `<package>/dashboard`, from `src/` or `dist/`. */
export const DEFAULT_DASHBOARD_DIR = fileURLToPath(new URL('../../dashboard', import.meta.url));

const BODY_LIMIT = 16 * 1024 * 1024;

function respLimits(config: MindlogConfig): ConnectionLimits {
  const { limits } = config;
  return {
    parser: {
      maxBulkBytes: limits.maxBulkBytes,
      maxInlineBytes: limits.maxInlineBytes,
      maxArgs: limits.maxArgs,
    },
    outputBufferBytes: limits.outputBufferBytes,
    maxPipeline: limits.maxPipelineCommands,
  };
}

/** The configuration as the dashboard shows it, secrets replaced. */
/** Retries while a new node has no leader or cluster version yet (about a minute). */
async function withRetries(
  run: () => Promise<Result<void, MindlogError>>,
): Promise<Result<void, MindlogError>> {
  for (let attempt = 0; ; attempt++) {
    const result = await run();
    if (
      result.ok ||
      !['UNAVAILABLE', 'NOT_LEADER', 'RANGE_MOVED'].includes(result.error.code) ||
      attempt >= 60
    )
      return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export function redactedSettings(config: MindlogConfig): Record<string, unknown> {
  return {
    ...config,
    auth: {
      password: config.auth.password === undefined ? null : '[redacted]',
      oauth2: config.auth.oauth2.map((p) => ({ ...p, clientSecret: '[redacted]' })),
    },
    mail: {
      ...config.mail,
      ...(config.mail.password === undefined ? {} : { password: '[redacted]' }),
    },
  };
}

async function overview(
  core: NodeCore,
  context: ServerContext,
  config: MindlogConfig,
  http: () => string,
) {
  const session = core.service.openSession('overview');
  session.authenticated = true;
  const dbsize = await core.service.execute(session, [new TextEncoder().encode('DBSIZE')]);
  const memory = process.memoryUsage();
  return {
    nodeId: config.node.id,
    version: mindlogVersion(),
    profile: config.profile,
    startedAt: new Date(Number(context.info.startedAtMs)).toISOString(),
    uptimeMs: Number(context.clock.now() - context.info.startedAtMs),
    keys: dbsize.kind.case === 'integer' ? Number(dbsize.kind.value) : null,
    appliedIndex: core.machine.appliedIndex.toString(),
    clients: context.clients.size,
    resp: `${config.listen.resp.host}:${String(context.info.port)}`,
    http: http(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}

/**
 * Starts a node: its range replica (one voter, or a cluster member), state
 * machine, KV service, RESP and HTTP listeners, and the leader-only expiry
 * and GC jobs. The only place
 * that knows every concrete adapter (CLAUDE.md §3.1).
 */
export async function startNode(
  config: MindlogConfig,
  options: NodeOptions = {},
): Promise<Result<RunningNode, MindlogError>> {
  const logger =
    options.logger ?? createLogger({ level: config.observability.logLevel, name: 'mindlog' });
  const metrics = options.metrics ?? new PromMetrics();
  if (metrics instanceof PromMetrics && !options.metrics) metrics.collectProcessMetrics();
  const clock = options.clock ?? new SystemClock();
  const tracing = initTracing({
    serviceName: 'mindlog',
    endpoint: config.observability.tracing.endpoint,
    sampleRatio: config.observability.tracing.sampleRatio,
  });
  const tracer = new OtelTracer();
  const opened = await openNodeCore(config, { logger, metrics, clock, tracer });
  if (!opened.ok) {
    await tracing.shutdown();
    return opened;
  }
  const core = opened.value;
  const { service, replica, stamper, stateStore, machine } = core;

  const startedAtMs = clock.now();
  const context = {
    service,
    cluster: new ClusterService(replica),
    memory: core.memory,
    changes: core.changes,
    commands: new CommandTable(loadCommandSpecs()),
    clients: new ClientRegistry(),
    clock,
    logger,
    tracer,
    info: serverInfo(config, config.listen.resp.port, startedAtMs),
  };
  const handlers = createConnectionCommands();
  const limits = respLimits(config);
  const resp = new RespServer({
    context,
    handlers,
    metrics,
    options: {
      host: config.listen.resp.host,
      port: config.listen.resp.port,
      maxClients: config.limits.maxClients,
      idleTimeoutMs: config.limits.idleTimeoutMs,
      limits,
    },
  });
  let ready = false;
  let httpAddress = '';
  const admin = new AdminService({ service, clock });
  const apiKeys = new ApiKeyService({ service, clock });
  const appAuth = openAppAuth({
    config,
    collections: core.collections,
    kv: service,
    clock,
    logger,
  });
  const files = new RecordFiles({
    collections: core.collections,
    blob: openBlobStore(config, clock),
    auth: appAuth,
    clock,
    thumbnailer: sharpThumbnailer,
  });
  const hooks = core.collections.hooks;
  for (const w of collectionWorkers({
    collections: core.collections,
    files,
    clock,
    logger,
    ...(hooks ? { hooks } : {}),
  }))
    core.workers.register(w);
  const httpOptions: HttpServerOptions = {
    host: config.listen.http.host,
    port: config.listen.http.port,
    bodyLimit: BODY_LIMIT,
  };
  const http = new HttpServer({
    admin,
    kv: service,
    browser: new KvBrowser(service),
    cluster: new ClusterDirectory(core.pdAdmin),
    memory: core.memory,
    changes: core.changes,
    apiKeys,
    collections: core.collections,
    appAuth,
    files,
    broker: new RecordBroker({ collections: core.collections, feed: core.changes, clock }),
    defaultTenant: config.collections.defaultTenant,
    authRateLimit: { burst: config.limits.authBurst, perMinute: config.limits.authPerMinute },
    resp: { server: context, handlers, limits },
    prometheus:
      metrics instanceof PromMetrics
        ? metrics
        : { render: () => Promise.resolve(''), contentType: 'text/plain; version=0.0.4' },
    metrics,
    tracer,
    logger,
    clock,
    version: mindlogVersion(),
    ready: () => ready,
    overview: () => overview(core, context, config, () => httpAddress),
    settings: () => redactedSettings(config),
    dashboardDir: options.dashboardDir ?? DEFAULT_DASHBOARD_DIR,
    options: httpOptions,
  });

  const mcp = new McpHttpServer({
    memory: core.memory,
    changes: core.changes,
    keys: apiKeys,
    host: config.listen.mcp.http.host,
    port: config.listen.mcp.http.port,
    allowedHosts: config.listen.mcp.http.allowedHosts,
    version: mindlogVersion(),
  });
  const respBound = await resp.listen();
  const httpBound = respBound.ok ? await http.listen() : undefined;
  const mcpBound = httpBound?.ok ? await mcp.listen() : undefined;
  if (!respBound.ok || !httpBound?.ok || !mcpBound?.ok) {
    if (httpBound?.ok) await http.close();
    if (respBound.ok) await resp.close();
    await core.close();
    await tracing.shutdown();
    const failed = [respBound, httpBound, mcpBound].find((b) => b && !b.ok);
    return err((failed as { error: MindlogError }).error);
  }
  // The bound port is known only now (port 0); no connection has been accepted yet.
  context.info = serverInfo(config, respBound.value.port, startedAtMs);
  httpAddress = `${httpBound.value.address}:${String(httpBound.value.port)}`;

  const jobs = new RangeJobs({
    store: core.store,
    state: stateStore,
    workers: core.workers,
    stamper,
    clock,
    logger,
    metrics,
    ...(config.features.crossRangeTxn
      ? {
          resolve: (held: HeldLock) =>
            service.resolveLock(held.tenant, held.key, held.lock.primary, held.lock.startTs),
        }
      : {}),
  });
  jobs.start();
  logger.info('node started', {
    nodeId: config.node.id,
    dataDir: core.dataDir,
    resp: `${respBound.value.address}:${String(respBound.value.port)}`,
    http: httpAddress,
    mcp: `${mcpBound.value.address}:${String(mcpBound.value.port)}`,
    ...(core.transport
      ? { internal: `${core.transport.address.address}:${String(core.transport.address.port)}` }
      : {}),
    raftId: config.node.raftId,
    replayed: core.replayed,
    appliedIndex: machine.appliedIndex,
  });
  const superusers = await admin.hasSuperusers();
  if (superusers.ok && !superusers.value) {
    logger.warn(
      'no superuser yet: stop the server and run `mindlog-server superuser upsert <email> <password>`',
    );
  }

  let closing: Promise<void> | undefined;
  const close = async () => {
    ready = false;
    await mcp.close();
    await http.close();
    await resp.close();
    await jobs.stop();
    await core.close();
    await tracing.shutdown();
    logger.info('node stopped', { nodeId: config.node.id, appliedIndex: machine.appliedIndex });
  };
  const tenant = config.collections.defaultTenant;
  const migrated = await withRetries(() =>
    runMigrations(config.collections.migrationsDir, core.collections, tenant, logger),
  );
  if (!migrated.ok) {
    await close();
    return migrated;
  }
  if (hooks) {
    const crons = await withRetries(() => ensureCrons(core.collections, hooks, tenant, clock));
    if (!crons.ok) logger.error('cron jobs were not started', { err: crons.error.message });
  }
  ready = true;
  return ok({
    config,
    resp: respBound.value,
    http: httpBound.value,
    mcp: mcpBound.value,
    apiKeys,
    admin,
    internal: core.transport?.address,
    replica,
    logger,
    metrics,
    replayed: core.replayed,
    close: () => (closing ??= close()),
  });
}
