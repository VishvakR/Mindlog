import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accessOf } from '@mindlog/auth';
import { mindlogError } from '@mindlog/core';
import type { HttpServerDeps } from '../http-deps.js';
import { bearerOf, contextOf, identityOf } from '../identity.js';
import { sendProblem } from '../route.js';

const query = z.strictObject({
  tenant: z.string().min(1).max(128).optional(),
  user: z.string().max(128),
  from: z.string().max(64).optional(),
});

const subscribeBody = z.object({
  clientId: z.string().max(64),
  subscriptions: z.array(z.string().max(128)),
});

/** Bytes queued on one stream before a slow reader is dropped. */
const MAX_BUFFERED = 4 * 1024 * 1024;

/** Comment line that keeps proxies from closing an idle stream. */
const HEARTBEAT_MS = 15_000;

/**
 * `GET /api/realtime?tenant=&user=&from=`: a user scope's memory changes as
 * Server-Sent Events (PLAN 13.5). Each event's id is its cursor, so a
 * reconnecting client resumes with `Last-Event-ID` (or `from`); a cursor this
 * node no longer holds gets a `resync` event.
 */
export function realtimeRoutes(app: FastifyInstance, deps: HttpServerDeps): void {
  app.post('/api/realtime', { config: { auth: false } }, async (request, reply) => {
    if (!deps.broker)
      return sendProblem(reply, mindlogError('UNIMPLEMENTED', 'realtime is not available'));
    const body = subscribeBody.safeParse(request.body ?? {});
    if (!body.success)
      return sendProblem(reply, mindlogError('INVALID_ARGUMENT', 'bad subscription request'));
    const ctx = await contextOf(request, deps, 'realtime');
    if (!ctx.ok) return sendProblem(reply, ctx.error);
    const token = bearerOf(request);
    const done = deps.broker.subscribe(
      body.data.clientId,
      ctx.value,
      body.data.subscriptions,
      async () => {
        const again = await identityOf(request, deps, token);
        return again.ok;
      },
    );
    return done.ok ? reply.code(204).send() : sendProblem(reply, done.error);
  });
  app.get('/api/realtime', { config: { auth: false } }, async (request, reply) => {
    if (!Object.hasOwn(request.query as object, 'user')) return recordStream(request, reply, deps);
    const who = await identityOf(request, deps);
    if (!who.ok) return sendProblem(reply, who.error);
    if (who.value.identity.kind === 'anonymous')
      return sendProblem(reply, mindlogError('UNAUTHENTICATED', 'Missing or invalid auth token.'));
    const feed = deps.changes;
    if (!feed)
      return sendProblem(reply, mindlogError('UNIMPLEMENTED', 'change streams are not available'));
    const parsed = query.safeParse(request.query);
    if (!parsed.success)
      return sendProblem(
        reply,
        mindlogError('INVALID_ARGUMENT', parsed.error.issues[0]?.message ?? 'bad query'),
      );
    const tenant = parsed.data.tenant ?? who.value.tenant;
    const allowed = await deps.access.check(accessOf(who.value.identity), 'memory.read', {
      tenant,
      scope: parsed.data.user,
    });
    if (!allowed.ok) return sendProblem(reply, allowed.error);
    const lastId = request.headers['last-event-id'];
    const from =
      (typeof lastId === 'string' && lastId !== '' ? lastId : undefined) ?? parsed.data.from;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    raw.write(': mindlog change stream\n\n');
    const stop = feed.subscribe({ tenant, user: parsed.data.user }, from, (e) => {
      raw.write(
        e.type === 'resync'
          ? 'event: resync\ndata: {}\n\n'
          : `id: ${e.cursor}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
      );
    });
    const beat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
    request.raw.on('close', () => {
      clearInterval(beat);
      stop();
    });
    return reply;
  });
}

/**
 * `GET /api/realtime` without `user`: PocketBase's protocol (PLAN 16.6). The
 * stream opens with `PB_CONNECT`; `POST /api/realtime` then sets what it follows.
 */
function recordStream(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: HttpServerDeps,
): FastifyReply {
  const broker = deps.broker;
  if (!broker)
    return sendProblem(reply, mindlogError('UNIMPLEMENTED', 'realtime is not available'));
  const raw = reply.raw;
  const lastId = request.headers['last-event-id'];
  const close = () => raw.destroy();
  const connected = broker.connect(
    (m) => {
      if (raw.writableLength > MAX_BUFFERED) {
        close();
        return;
      }
      raw.write(
        `${m.id ? `id: ${m.id}\n` : ''}event: ${m.event}\ndata: ${JSON.stringify(m.data)}\n\n`,
      );
    },
    close,
    typeof lastId === 'string' && lastId !== '' ? lastId : undefined,
  );
  if (!connected.ok) return sendProblem(reply, connected.error);
  reply.hijack();
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  raw.write(`event: PB_CONNECT\ndata: ${JSON.stringify({ clientId: connected.value })}\n\n`);
  const beat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
  request.raw.on('close', () => {
    clearInterval(beat);
    broker.disconnect(connected.value);
  });
  return reply;
}
