import type { FastifyInstance } from 'fastify';
import { ok } from '@mindlog/core';
import { accessOf, principalOf } from '@mindlog/auth';
import type { Session } from '@mindlog/services';
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
import type { AnyRouteSpec, Who } from '../route.js';
import { defineRoute } from '../route.js';

const keyEncodingQuery = keyQuerySchema.pick({ encoding: true });
let requests = 0;

/** REST access to Redis keys for the data browser (PLAN 24 phase 2). */
export function kvRoutes(app: FastifyInstance, routes: AnyRouteSpec[], deps: HttpServerDeps): void {
  const session = (who: Who | undefined): Session => {
    const s = deps.kv.openSession(`http:${String(++requests)}`);
    if (!who) {
      s.authenticated = false;
      return s;
    }
    s.authenticated = true;
    s.tenant = who.tenant;
    s.access = accessOf(who.identity);
    s.principal =
      who.identity.kind === 'superuser' ? who.identity.email : principalOf(who.identity);
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
      auth: 'identity',
      query: scanQuerySchema,
      response: scanResultSchema,
    },
    ({ query, who }) => deps.browser.scan(session(who), query),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/kv/keys/:key',
      summary: 'Read a key as a typed value',
      tag: 'kv',
      auth: 'identity',
      query: keyQuerySchema,
      response: keyDetailSchema,
    },
    ({ query, params, who }) => deps.browser.read(session(who), key(params, query.encoding), query),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'PUT',
      path: '/api/kv/keys/:key',
      summary: 'Replace a key with a typed value and TTL',
      tag: 'kv',
      auth: 'identity',
      query: keyEncodingQuery,
      body: writeKeyBodySchema,
    },
    ({ query, params, body, who }) =>
      deps.browser.write(session(who), key(params, query.encoding), body),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'DELETE',
      path: '/api/kv/keys/:key',
      summary: 'Delete a key',
      tag: 'kv',
      auth: 'identity',
      query: keyEncodingQuery,
    },
    ({ query, params, who }) => deps.browser.remove(session(who), key(params, query.encoding)),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'PUT',
      path: '/api/kv/keys/:key/ttl',
      summary: 'Set (ttlMs) or clear (null) the TTL',
      tag: 'kv',
      auth: 'identity',
      query: keyEncodingQuery,
      body: ttlBodySchema,
    },
    async ({ query, params, body, who }) => {
      const r = await deps.browser.setTtl(session(who), key(params, query.encoding), body.ttlMs);
      return r.ok ? ok(undefined) : r;
    },
  );
}
