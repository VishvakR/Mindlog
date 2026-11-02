import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MindlogError, Result } from '@mindlog/core';
import { mindlogError } from '@mindlog/core';
import type { Superuser } from '@mindlog/services';
import type { z } from 'zod';
import type { Problem } from './problem.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from './problem.js';

/** One documented route: drives both registration and the OpenAPI document. */
export interface RouteSpec<B extends z.ZodType, Q extends z.ZodType, R extends z.ZodType> {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Fastify path, e.g. `/api/kv/keys/:key`. */
  readonly path: string;
  readonly summary: string;
  readonly tag: string;
  /** Requires a superuser bearer token (default true). */
  readonly auth?: boolean;
  readonly body?: B;
  readonly query?: Q;
  /** 200 response body; omitted for 204. */
  readonly response?: R;
  /** Largest request body in bytes, when it differs from the server's (archive imports). */
  readonly bodyLimit?: number;
}

export interface RouteInput<B, Q> {
  readonly body: B;
  readonly query: Q;
  readonly params: Readonly<Record<string, string>>;
  readonly superuser: Superuser | undefined;
  readonly request: FastifyRequest;
}

export type AnyRouteSpec = RouteSpec<z.ZodType, z.ZodType, z.ZodType>;

/** Request-scoped state set by the auth hook. */
declare module 'fastify' {
  interface FastifyRequest {
    superuser?: Superuser;
  }
}

const invalid = (issues: z.core.$ZodIssue[]): MindlogError =>
  mindlogError('INVALID_ARGUMENT', 'Request validation failed.', {
    fields: Object.fromEntries(issues.map((i) => [i.path.join('.') || '_', i.message])),
  });

export function sendProblem(reply: FastifyReply, error: MindlogError): FastifyReply {
  const problem: Problem = toProblem(error);
  return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/**
 * Registers a route whose handler returns a `Result`: validates query and body
 * with the spec's Zod schemas, answers 200 (or 204 for `undefined`) on success
 * and RFC 9457 problem details on failure.
 */
export function defineRoute<B extends z.ZodType, Q extends z.ZodType, R extends z.ZodType>(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  spec: RouteSpec<B, Q, R>,
  handler: (
    input: RouteInput<z.infer<B>, z.infer<Q>>,
  ) => Promise<Result<z.infer<R> | undefined, MindlogError>>,
): void {
  routes.push(spec);
  app.route({
    method: spec.method,
    url: spec.path,
    config: { auth: spec.auth ?? true },
    ...(spec.bodyLimit ? { bodyLimit: spec.bodyLimit } : {}),
    handler: async (request, reply) => {
      const body = spec.body ? spec.body.safeParse(request.body ?? {}) : undefined;
      if (body && !body.success) return sendProblem(reply, invalid(body.error.issues));
      const query = spec.query ? spec.query.safeParse(request.query ?? {}) : undefined;
      if (query && !query.success) return sendProblem(reply, invalid(query.error.issues));
      const result = await handler({
        body: body?.data as z.infer<B>,
        query: query?.data as z.infer<Q>,
        params: request.params as Record<string, string>,
        superuser: request.superuser,
        request,
      });
      if (!result.ok) return sendProblem(reply, result.error);
      return result.value === undefined ? reply.code(204).send() : reply.send(result.value);
    },
  });
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** False for public routes (health, login, OpenAPI). */
    auth?: boolean;
  }
}
