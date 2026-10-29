import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { MemoryService } from '@mindlog/services';
import {
  forgetSchema,
  getMemorySchema,
  graphSchema,
  historySchema,
  listMemorySchema,
  recallSchema,
  rememberSchema,
  scopesSchema,
} from '@mindlog/services';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const anyObject = z.record(z.string(), z.unknown());
const tenant = { tenant: z.string().min(1).max(128).default('default') };

type Method =
  'remember' | 'recall' | 'pack' | 'get' | 'list' | 'forget' | 'history' | 'graph' | 'scopes';

type Caller = Parameters<MemoryService['get']>[0];
// Each operation's input was validated by its route schema; the service validates it again.
const CALLS: Record<
  Method,
  (m: MemoryService, c: Caller, i: never) => Promise<Result<unknown, MindlogError>>
> = {
  remember: (m, c, i) => m.remember(c, i),
  recall: (m, c, i) => m.recall(c, i),
  // The packed context is part of every recall; `pack` names that use (MEM.PACK).
  pack: (m, c, i) => m.recall(c, i),
  get: (m, c, i) => m.get(c, i),
  list: (m, c, i) => m.list(c, i),
  forget: (m, c, i) => m.forget(c, i),
  history: (m, c, i) => m.history(c, i),
  graph: (m, c, i) => m.graph(c, i),
  scopes: (m, c, i) => m.scopes(c, i),
};

const ROUTES: ReadonlyArray<{ op: Method; summary: string; schema: z.ZodObject }> = [
  {
    op: 'remember',
    summary: 'Remember text in a scope (extract, embed, index)',
    schema: rememberSchema,
  },
  {
    op: 'recall',
    summary: 'Recall the memories most relevant to a query, with scores',
    schema: recallSchema,
  },
  {
    op: 'pack',
    summary: 'Recall and pack the best context within a token budget, grouped by kind',
    schema: recallSchema,
  },
  { op: 'get', summary: 'One memory of a scope', schema: getMemorySchema },
  { op: 'list', summary: 'Memories of a scope, oldest first, by cursor', schema: listMemorySchema },
  { op: 'forget', summary: 'Forget memories (append-only; history is kept)', schema: forgetSchema },
  { op: 'history', summary: 'Stored versions of a memory, newest first', schema: historySchema },
  {
    op: 'graph',
    summary: "An entity's neighbourhood and the memories mentioning it",
    schema: graphSchema,
  },
  { op: 'scopes', summary: 'User scopes of the tenant that hold memory', schema: scopesSchema },
];

/** REST mirror of the memory operations (PLAN 15.3), for the dashboard and scripts. */
export function memoryRoutes(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  deps: HttpServerDeps,
): void {
  for (const route of ROUTES) {
    defineRoute(
      app,
      routes,
      {
        method: 'POST',
        path: `/api/memory/${route.op}`,
        summary: route.summary,
        tag: 'memory',
        body: route.schema.extend(tenant),
        response: anyObject.or(z.null()),
      },
      async ({ body, superuser }) => {
        const memory: MemoryService | undefined = deps.memory;
        if (!memory)
          return err(mindlogError('UNIMPLEMENTED', 'memory is not available on this node'));
        const { tenant: name, ...input } = body as { tenant: string } & Record<string, unknown>;
        const caller = { tenant: name, principal: superuser?.email ?? 'http' };
        const result = await CALLS[route.op](memory, caller, input as never);
        // A missing memory is null, not 204.
        return result.ok ? ok((result.value ?? null) as Record<string, unknown> | null) : result;
      },
    );
  }
}
