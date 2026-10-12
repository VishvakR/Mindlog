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
import { ExpiryJob, GcJob } from '@mindlog/kv';
import { AdminService, KvBrowser } from '@mindlog/services';
import type { NodeCore } from './open-node-core.js';
import { openNodeCore } from './open-node-core.js';
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
  readonly logger: Logger;
  readonly metrics: Metrics;
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
export function redactedSettings(config: MindlogConfig): Record<string, unknown> {
  return {
    ...config,
    auth: { password: config.auth.password === undefined ? null : '[redacted]' },
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
 * Starts a single node: durable local log, state machine, KV service, RESP
 * and HTTP listeners, and the replicated expiry and GC jobs. The only place
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
  const { service, proposer, stamper, stateStore, machine } = core;

  const startedAtMs = clock.now();
  const context = {
    service,
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
  const httpOptions: HttpServerOptions = {
    host: config.listen.http.host,
    port: config.listen.http.port,
    bodyLimit: BODY_LIMIT,
  };
  const http = new HttpServer({
    admin,
    kv: service,
    browser: new KvBrowser(service),
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

  const respBound = await resp.listen();
  const httpBound = respBound.ok ? await http.listen() : undefined;
  if (!respBound.ok || !httpBound?.ok) {
    if (respBound.ok) await resp.close();
    await core.close();
    await tracing.shutdown();
    return err(respBound.ok ? (httpBound as { error: MindlogError }).error : respBound.error);
  }
  // The bound port is known only now (port 0); no connection has been accepted yet.
  context.info = serverInfo(config, respBound.value.port, startedAtMs);
  httpAddress = `${httpBound.value.address}:${String(httpBound.value.port)}`;

  const expiry = new ExpiryJob({ store: stateStore, proposer, stamper, clock, logger, metrics });
  const gc = new GcJob({
    proposer,
    stamper,
    appliedIndex: () => machine.appliedIndex,
    logger,
    metrics,
  });
  expiry.start();
  gc.start();
  ready = true;
  logger.info('node started', {
    nodeId: config.node.id,
    dataDir: core.dataDir,
    resp: `${respBound.value.address}:${String(respBound.value.port)}`,
    http: httpAddress,
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
    await http.close();
    await resp.close();
    await Promise.all([expiry.stop(), gc.stop()]);
    await core.close();
    await tracing.shutdown();
    logger.info('node stopped', { nodeId: config.node.id, appliedIndex: machine.appliedIndex });
  };
  return ok({
    config,
    resp: respBound.value,
    http: httpBound.value,
    logger,
    metrics,
    replayed: core.replayed,
    close: () => (closing ??= close()),
  });
}
