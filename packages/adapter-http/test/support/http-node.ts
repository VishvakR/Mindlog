import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  OtelTracer,
  PromMetrics,
  SeededRandom,
  UlidGenerator,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  createKvRegistry,
  expireHandler,
  gcThresholdHandler,
  kvBatchHandler,
  kvWriteHandler,
} from '@mindlog/kv';
import type { ChangeFeed, MemoryService, PdAdmin } from '@mindlog/services';
import {
  AccessControl,
  AccessPorts,
  AdminService,
  TenantService,
  ApiKeyService,
  ClusterDirectory,
  KvBrowser,
  KvService,
  StaticAuthenticator,
} from '@mindlog/services';
import { startSingleNode } from '@mindlog/multiraft';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
} from '@mindlog/statemachine';
import { MemoryStore } from '@mindlog/storage';
import type { ServerContext } from '@mindlog/adapter-resp';
import {
  ClientRegistry,
  CommandTable,
  DEFAULT_LIMITS,
  createConnectionCommands,
  loadCommandSpecs,
} from '@mindlog/adapter-resp';
import { HttpServer } from '@mindlog/adapter-http';

export const ADMIN = { email: 'admin@example.com', password: 'correct horse battery' };

/** An HttpServer over an in-memory single-node stack, with one superuser. */
export async function httpNode(
  options: {
    ready?: boolean;
    dashboardDir?: string;
    pd?: PdAdmin;
    memory?: MemoryService;
    changes?: ChangeFeed;
  } = {},
) {
  const clock = new ManualClock(1_760_000_000_000n);
  const logger = new MemoryLogger();
  const metrics = new PromMetrics();
  const registry = createKvRegistry();
  const applyHandlers = new ApplyHandlerRegistry();
  for (const h of [
    kvWriteHandler(registry),
    kvBatchHandler(registry),
    expireHandler,
    gcThresholdHandler,
  ]) {
    applyHandlers.register(h);
  }
  const store = new MemoryStore();
  const machine = await StateMachine.open({
    store,
    handlers: applyHandlers,
    events: new InMemoryEventBus({ logger, metrics }),
    clock,
    logger,
    metrics,
  });
  const proposer = await startSingleNode({
    log: new RaftLogStore(new MemoryStore()),
    machine,
    clock,
    logger,
    metrics,
  });
  const tracer = new OtelTracer();
  const ports = new AccessPorts();
  const kv = new KvService({
    authorize: (a, action, resource) => ports.authorize(a, action, resource),
    registry,
    store,
    proposer,
    readBarrier: proposer,
    stamper: new CommandStamper(
      new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
      new UlidGenerator(clock, new SeededRandom(1n)),
    ),
    clock,
    authenticator: new StaticAuthenticator('resp-password'),
    metrics,
    tracer,
  });
  const admin = new AdminService({ service: kv, clock });
  await admin.upsertSuperuser(ADMIN);
  const server: ServerContext = {
    service: kv,
    commands: new CommandTable(loadCommandSpecs()),
    clients: new ClientRegistry(),
    clock,
    logger,
    info: {
      redisVersion: '7.2.0',
      mindlogVersion: '0.0.0',
      port: 6379,
      startedAtMs: clock.now(),
      processId: 4242,
      settings: { databases: '1', maxclients: '10000' },
    },
  };
  const tenants = new TenantService({ service: kv, clock });
  const access = new AccessControl(tenants);
  ports.attach({
    authorize: access.check,
    verify: () => Promise.reject(new Error('no API keys in this harness')),
  });
  const http = new HttpServer({
    admin,
    tenants,
    access,
    apiKeys: new ApiKeyService({ service: kv, clock }),
    kv,
    browser: new KvBrowser(kv),
    cluster: new ClusterDirectory(options.pd),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.changes ? { changes: options.changes } : {}),
    resp: {
      server,
      handlers: createConnectionCommands(),
      limits: { parser: DEFAULT_LIMITS, outputBufferBytes: 64 * 1024 * 1024, maxPipeline: 1024 },
    },
    prometheus: metrics,
    metrics,
    tracer,
    logger,
    clock,
    version: '0.0.0-test',
    ready: () => options.ready ?? true,
    overview: () => Promise.resolve({ version: '0.0.0-test', keys: 0 }),
    settings: () => ({ auth: { password: '[redacted]' } }),
    ...(options.dashboardDir ? { dashboardDir: options.dashboardDir } : {}),
    options: { host: '127.0.0.1', port: 0, bodyLimit: 1024 * 1024 },
  });
  await http.ready();
  const login = await http.app.inject({
    method: 'POST',
    url: '/api/superusers/auth-with-password',
    payload: ADMIN,
  });
  const token = login.json<{ token: string }>().token;
  const authed = { authorization: `Bearer ${token}` };
  const session = kv.openSession('test');
  session.authenticated = true;
  const run = async (...args: string[]) =>
    kv.execute(
      session,
      args.map((a) => new TextEncoder().encode(a)),
    );
  return { http, app: http.app, kv, admin, clock, metrics, token, authed, run };
}
