import type { AddressInfo } from 'node:net';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { HttpServerDeps } from './http-deps.js';
import { openApiDocument } from './openapi.js';
import type { AnyRouteSpec } from './route.js';
import { sendProblem } from './route.js';
import { adminRoutes } from './routes/admin-routes.js';
import { clusterRoutes } from './routes/cluster-routes.js';
import { memoryRoutes } from './routes/memory-routes.js';
import { apiKeyRoutes } from './routes/api-key-routes.js';
import { CONSOLE_PROTOCOL, consoleRoutes } from './routes/console-routes.js';
import { dashboardRoutes, isSpaRoute } from './routes/dashboard-routes.js';
import { healthRoutes } from './routes/health-routes.js';
import { kvRoutes } from './routes/kv-routes.js';
import { superuserRoutes } from './routes/superuser-routes.js';

const BEARER = 'bearer.';

/** The bearer token from `Authorization`, or from the console's WebSocket subprotocols. */
function tokenOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const protocols = request.headers['sec-websocket-protocol']?.split(',').map((p) => p.trim());
  return protocols?.find((p) => p.startsWith(BEARER))?.slice(BEARER.length);
}

/**
 * The HTTP listener (PLAN 15.3, 17): health and metrics, the REST API with RFC
 * 9457 errors and an OpenAPI document, the RESP console over WebSocket, and the
 * dashboard at `/_/`. Thin: every request goes to an application service.
 */
export class HttpServer {
  readonly app: FastifyInstance;
  readonly #deps: HttpServerDeps;
  readonly #routes: AnyRouteSpec[] = [];
  #started: Promise<void> | undefined;

  constructor(deps: HttpServerDeps) {
    this.#deps = deps;
    this.app = Fastify({ logger: false, bodyLimit: deps.options.bodyLimit });
  }

  /** Registers hooks and routes; `listen` and tests (`app.inject`) call it. */
  ready(): Promise<void> {
    this.#started ??= this.#setup();
    return this.#started;
  }

  async #setup(): Promise<void> {
    const { app } = this;
    const deps = this.#deps;
    // First, so its onRequest hook (which ends refused upgrades) runs before ours.
    await app.register(fastifyWebsocket, {
      options: {
        maxPayload: deps.resp.limits.parser.maxBulkBytes,
        handleProtocols: (protocols) =>
          protocols.has(CONSOLE_PROTOCOL) ? CONSOLE_PROTOCOL : false,
      },
    });
    const latency = deps.metrics.histogram({
      name: 'mindlog_http_request_latency_seconds',
      help: 'HTTP request latency, by method, route and status',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    });
    const errors = deps.metrics.counter({
      name: 'mindlog_http_request_errors_total',
      help: 'HTTP responses with status >= 400, by route and status',
      labelNames: ['route', 'status'],
    });
    const started = new WeakMap<FastifyRequest, bigint>();
    app.addHook('onRequest', async (request, reply) => {
      started.set(request, deps.clock.monotonic());
      reply.header('x-content-type-options', 'nosniff');
      if (!request.url.startsWith('/api/') || request.routeOptions.config.auth === false) return;
      const token = tokenOf(request);
      const superuser = token
        ? await deps.admin.verifyToken(token)
        : err(mindlogError('UNAUTHENTICATED', 'Missing or invalid auth token.'));
      if (!superuser.ok) return sendProblem(reply, superuser.error);
      request.superuser = superuser.value;
    });
    app.addHook('onResponse', async (request, reply) => {
      const route = request.routeOptions.url ?? 'unmatched';
      const status = String(reply.statusCode);
      const begin = started.get(request) ?? deps.clock.monotonic();
      latency.observe(Number(deps.clock.monotonic() - begin) / 1e9, {
        method: request.method,
        route,
        status,
      });
      if (reply.statusCode >= 400) errors.inc(1, { route, status });
    });
    // Each handler runs inside an `http.request` span, so service spans nest under it.
    app.addHook('onRoute', (route) => {
      // Static dashboard files stream their reply after the handler returns; they get no span.
      if (route.websocket || route.url.startsWith('/_')) return;
      const handler = route.handler;
      route.handler = function traced(request, reply) {
        return deps.tracer.withSpan(
          'http.request',
          { 'http.method': request.method, 'http.route': route.url },
          () => Promise.resolve(handler.call(this, request, reply)),
        );
      };
    });
    app.setErrorHandler((error, request, reply) => {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) deps.logger.error('http handler failed', { err: error, url: request.url });
      const code =
        status === 413 ? 'PAYLOAD_TOO_LARGE' : status < 500 ? 'INVALID_ARGUMENT' : 'INTERNAL';
      return sendProblem(reply, mindlogError(code, status < 500 ? message : 'Internal error.'));
    });
    let dashboard = false;
    app.setNotFoundHandler((request, reply) => {
      if (dashboard && request.method === 'GET' && isSpaRoute(request.url)) {
        return reply.sendFile('index.html');
      }
      return sendProblem(
        reply,
        mindlogError(
          'NOT_FOUND',
          `No route for ${request.method} ${request.url.split('?')[0] ?? ''}`,
        ),
      );
    });

    healthRoutes(app, this.#routes, deps);
    superuserRoutes(app, this.#routes, deps);
    kvRoutes(app, this.#routes, deps);
    adminRoutes(app, this.#routes, deps);
    clusterRoutes(app, this.#routes, deps);
    memoryRoutes(app, this.#routes, deps);
    apiKeyRoutes(app, this.#routes, deps);
    consoleRoutes(app, deps);
    const document = () => openApiDocument(this.#routes, deps.version);
    app.get('/api/openapi.json', { config: { auth: false } }, () => document());
    dashboard = await dashboardRoutes(app, deps.dashboardDir);
    await app.ready();
  }

  /** Starts listening; resolves with the bound address. */
  async listen(): Promise<Result<AddressInfo, MindlogError>> {
    try {
      await this.ready();
      await this.app.listen({ host: this.#deps.options.host, port: this.#deps.options.port });
      const address = this.app.server.address();
      if (!address || typeof address === 'string')
        return err(mindlogError('INTERNAL', 'no TCP address'));
      return ok(address);
    } catch (cause) {
      const { host, port } = this.#deps.options;
      return err(
        mindlogError('UNAVAILABLE', `cannot listen on ${host}:${String(port)}`, { cause }),
      );
    }
  }

  /** Stops accepting, closes WebSockets and waits for in-flight requests. */
  async close(): Promise<void> {
    await this.app.close();
  }
}
