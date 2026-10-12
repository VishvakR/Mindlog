import type { FastifyInstance } from 'fastify';
import { ok } from '@mindlog/core';
import type { Session, Superuser } from '@mindlog/services';
import {
  keyDetailSchema,
  keyQuerySchema,
  scanQuerySchema,
  scanResultSchema,
  ttlBodySchema,
  writeKeyBodySchema,
} from '@mindlog/services';
import { toBytes } from '../key-bytes.js';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const keyEncodingQuery = keyQuerySchema.pick({ encoding: true });
let requests = 0;

/** REST access to Redis keys for the data browser (PLAN 24 phase 2). */
export function kvRoutes(app: FastifyInstance, routes: AnyRouteSpec[], deps: HttpServerDeps): void {
  const session = (superuser: Superuser | undefined): Session => {
    const s = deps.kv.openSession(`http:${String(++requests)}`);
    s.authenticated = true;
    s.principal = superuser?.email ?? 'anonymous';
    return s;
  };
  const key = (params: Readonly<Record<string, string>>, encoding: 'utf8' | 'base64') =>
    toBytes(params.key ?? '', encoding);

  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/kv/keys',
      summary: 'Scan keys (cursor paging) with type and TTL',
      tag: 'kv',
      query: scanQuerySchema,
      response: scanResultSchema,
    },
    ({ query, superuser }) => deps.browser.scan(session(superuser), query),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/kv/keys/:key',
      summary: 'Read a key as a typed value',
      tag: 'kv',
      query: keyQuerySchema,
      response: keyDetailSchema,
    },
    ({ query, params, superuser }) =>
      deps.browser.read(session(superuser), key(params, query.encoding), query),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'PUT',
      path: '/api/kv/keys/:key',
      summary: 'Replace a key with a typed value and TTL',
      tag: 'kv',
      query: keyEncodingQuery,
      body: writeKeyBodySchema,
    },
    ({ query, params, body, superuser }) =>
      deps.browser.write(session(superuser), key(params, query.encoding), body),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'DELETE',
      path: '/api/kv/keys/:key',
      summary: 'Delete a key',
      tag: 'kv',
      query: keyEncodingQuery,
    },
    ({ query, params, superuser }) =>
      deps.browser.remove(session(superuser), key(params, query.encoding)),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'PUT',
      path: '/api/kv/keys/:key/ttl',
      summary: 'Set (ttlMs) or clear (null) the TTL',
      tag: 'kv',
      query: keyEncodingQuery,
      body: ttlBodySchema,
    },
    async ({ query, params, body, superuser }) => {
      const r = await deps.browser.setTtl(
        session(superuser),
        key(params, query.encoding),
        body.ttlMs,
      );
      return r.ok ? ok(undefined) : r;
    },
  );
}
