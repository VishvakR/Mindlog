import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mindlogError } from '@mindlog/core';
import type { HttpServerDeps } from '../http-deps.js';
import { sendProblem } from '../route.js';

const query = z.strictObject({
  tenant: z.string().min(1).max(128).default('default'),
  user: z.string().max(128).default(''),
  from: z.string().max(64).optional(),
});

/** Comment line that keeps proxies from closing an idle stream. */
const HEARTBEAT_MS = 15_000;

/**
 * `GET /api/realtime?tenant=&user=&from=`: a user scope's memory changes as
 * Server-Sent Events (PLAN 13.5). Each event's id is its cursor, so a
 * reconnecting client resumes with `Last-Event-ID` (or `from`); a cursor this
 * node no longer holds gets a `resync` event.
 */
export function realtimeRoutes(app: FastifyInstance, deps: HttpServerDeps): void {
  app.get('/api/realtime', (request, reply) => {
    const feed = deps.changes;
    if (!feed)
      return sendProblem(reply, mindlogError('UNIMPLEMENTED', 'change streams are not available'));
    const parsed = query.safeParse(request.query);
    if (!parsed.success)
      return sendProblem(
        reply,
        mindlogError('INVALID_ARGUMENT', parsed.error.issues[0]?.message ?? 'bad query'),
      );
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
    const stop = feed.subscribe(
      { tenant: parsed.data.tenant, user: parsed.data.user },
      from,
      (e) => {
        raw.write(
          e.type === 'resync'
            ? 'event: resync\ndata: {}\n\n'
            : `id: ${e.cursor}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
        );
      },
    );
    const beat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
    request.raw.on('close', () => {
      clearInterval(beat);
      stop();
    });
    return reply;
  });
}
