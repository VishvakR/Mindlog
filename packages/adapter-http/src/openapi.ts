import { z } from 'zod';
import type { AnyRouteSpec } from './route.js';

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });

const problem = {
  description: 'RFC 9457 problem details',
  content: {
    'application/problem+json': {
      schema: {
        type: 'object',
        required: ['type', 'title', 'status', 'detail', 'code', 'retryable'],
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
          code: { type: 'string' },
          retryable: { type: 'boolean' },
          fields: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
    },
  },
};

const queryParameters = (query: z.ZodType) => {
  const json = schema(query) as { properties?: Record<string, unknown>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({
    name,
    in: 'query',
    required: json.required?.includes(name) ?? false,
    schema: s,
  }));
};

/** OpenAPI 3.1 built from the same Zod schemas that validate requests (ADR-0024). */
export function openApiDocument(routes: readonly AnyRouteSpec[], version: string): object {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      summary: r.summary,
      tags: [r.tag],
      ...((r.auth ?? true) ? { security: [{ bearer: [] }] } : {}),
      parameters: [...params, ...(r.query ? queryParameters(r.query) : [])],
      ...(r.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schema(r.body) } },
            },
          }
        : {}),
      responses: {
        ...(r.response
          ? {
              200: {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: z.toJSONSchema(r.response, { unrepresentable: 'any' }),
                  },
                },
              },
            }
          : { 204: { description: 'No content' } }),
        default: problem,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Mindlog HTTP API', version },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
}
