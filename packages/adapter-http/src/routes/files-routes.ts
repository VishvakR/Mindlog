import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Upload } from '@mindlog/services';
import type { MindlogError } from '@mindlog/core';
import { mindlogError } from '@mindlog/core';
import { z } from 'zod';
import type { HttpServerDeps } from '../http-deps.js';
import { contextOf } from '../identity.js';
import { sendProblem } from '../route.js';

const fileQuery = z.object({
  token: z.string().max(4096).optional(),
  thumb: z.string().max(16).optional(),
});

/** Text parts become body fields (repeats become lists), file parts uploads (PLAN 16.5). */
export async function multipartOf(
  request: FastifyRequest,
): Promise<{ body: Record<string, unknown>; uploads: Upload[] }> {
  const body: Record<string, unknown> = {};
  const uploads: Upload[] = [];
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const bytes = await part.toBuffer();
      if (part.filename !== '' && bytes.length > 0) {
        uploads.push({
          field: part.fieldname,
          filename: part.filename,
          mimetype: part.mimetype,
          bytes,
        });
      }
    } else if (Object.hasOwn(body, part.fieldname)) {
      body[part.fieldname] = [body[part.fieldname], part.value].flat();
    } else body[part.fieldname] = part.value;
  }
  return { body, uploads };
}

/** `GET /api/files/{collection}/{record}/{file}`: checked against the record's view rule. */
export function filesRoutes(app: FastifyInstance, deps: HttpServerDeps): void {
  app.get(
    '/api/files/:collection/:id/:filename',
    { config: { auth: false } },
    async (request, reply) => {
      const fail = (e: MindlogError) => sendProblem(reply, e);
      if (!deps.files)
        return fail(mindlogError('UNIMPLEMENTED', 'files are not available on this node'));
      const q = fileQuery.safeParse(request.query);
      if (!q.success) return fail(mindlogError('INVALID_ARGUMENT', 'bad file query'));
      const { collection, id, filename } = request.params as Record<string, string>;
      const ctx = await contextOf(request, deps, 'protectedFile');
      if (!ctx.ok) return fail(ctx.error);
      const file = await deps.files.read(ctx.value, collection ?? '', id ?? '', filename ?? '', {
        ...(q.data.token === undefined ? {} : { token: q.data.token }),
        ...(q.data.thumb === undefined ? {} : { thumb: q.data.thumb }),
      });
      if (!file.ok) return fail(file.error);
      reply
        .type(file.value.contentType)
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, max-age=60');
      if (file.value.attachment) reply.header('content-disposition', 'attachment');
      return reply.send(Buffer.from(file.value.bytes));
    },
  );
}
