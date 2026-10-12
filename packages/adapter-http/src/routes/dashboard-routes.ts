import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * Serves the built dashboard at `/_/`; client routes fall back to `index.html`
 * but missing assets (paths with an extension) are 404 (PocketBase `Static`).
 */
export async function dashboardRoutes(
  app: FastifyInstance,
  dir: string | undefined,
): Promise<void> {
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/_/')) reply.header('content-security-policy', CSP);
  });
  app.get('/_', { config: { auth: false } }, (_request, reply) => reply.redirect('/_/'));
  if (!dir || !existsSync(dir)) {
    app.get('/_/*', { config: { auth: false } }, (_request, reply) =>
      reply
        .code(404)
        .type('text/plain')
        .send(
          'Dashboard not built. Run `pnpm --filter @mindlog/web build`, then restart the server.',
        ),
    );
    return;
  }
  await app.register(fastifyStatic, {
    root: dir,
    prefix: '/_/',
    wildcard: false,
    index: ['index.html'],
  });
  app.get('/_/*', { config: { auth: false } }, (request, reply) => {
    if (extname(request.url.split('?')[0] ?? '')) {
      reply.callNotFound();
      return;
    }
    return reply.sendFile('index.html');
  });
}
