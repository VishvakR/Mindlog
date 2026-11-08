import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * Serves the built dashboard at `/_/`. Returns false when it is not built.
 * Files are looked up per request, so a rebuild needs no restart; client
 * routes fall back to `index.html` in the not-found handler (`spaFallback`).
 */
export async function dashboardRoutes(
  app: FastifyInstance,
  dir: string | undefined,
): Promise<boolean> {
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/_/')) reply.header('content-security-policy', CSP);
  });
  app.get('/_', { config: { auth: false } }, (_request, reply) => reply.redirect('/_/'));
  if (!dir || !existsSync(dir)) {
    app.get('/_/*', { config: { auth: false } }, (_request, reply) =>
      reply
        .code(404)
        .type('text/plain')
        .send('Dashboard not built. Run `pnpm --filter @mindlog/web build`, then reload.'),
    );
    return false;
  }
  await app.register(fastifyStatic, { root: dir, prefix: '/_/', index: ['index.html'] });
  return true;
}

/** Client routes (no file extension) under `/_/` get the app shell; missing assets stay 404 (PocketBase `Static`). */
export const isSpaRoute = (url: string): boolean =>
  url.startsWith('/_/') && extname(url.split('?')[0] ?? '') === '';
