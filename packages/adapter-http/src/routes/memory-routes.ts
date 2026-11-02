import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { MemoryService } from '@mindlog/services';
import {
  branchSchema,
  branchesSchema,
  conflictsSchema,
  mergeSchema,
  forgetSchema,
  getMemorySchema,
  graphSchema,
  historySchema,
  listMemorySchema,
  recallSchema,
  rememberSchema,
  resolveSchema,
  scopesSchema,
  trustSchema,
  consolidateSchema,
  exportSchema,
  importSchema,
  jobsSchema,
  pinSchema,
} from '@mindlog/services';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const anyObject = z.record(z.string(), z.unknown());
const tenant = { tenant: z.string().min(1).max(128).default('default') };

type Method =
  | 'remember'
  | 'recall'
  | 'pack'
  | 'get'
  | 'list'
  | 'forget'
  | 'history'
  | 'graph'
  | 'scopes'
  | 'conflicts'
  | 'resolve'
  | 'trust'
  | 'branch'
  | 'branches'
  | 'diff'
  | 'merge'
  | 'drop'
  | 'pin'
  | 'consolidate'
  | 'jobs'
  | 'export'
  | 'import';

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
  conflicts: (m, c, i) => m.conflicts(c, i),
  resolve: (m, c, i) => m.resolve(c, i),
  trust: (m, c, i) => m.trust(c, i),
  branch: (m, c, i) => m.createBranch(c, i),
  branches: (m, c, i) => m.branches(c, i),
  diff: (m, c, i) => m.diffBranch(c, i),
  merge: (m, c, i) => m.mergeBranch(c, i),
  drop: (m, c, i) => m.dropBranch(c, i),
  pin: (m, c, i) => m.pin(c, i),
  consolidate: (m, c, i) => m.consolidate(c, i),
  jobs: (m, c, i) => m.jobs(c, i),
  export: (m, c, i) => m.exportCube(c, i),
  import: (m, c, i) => m.importCube(c, i),
};

/** Largest import request: a 32 MB archive in base64 plus the JSON around it. */
const IMPORT_BODY_LIMIT = 48 * 1024 * 1024;

const ROUTES: ReadonlyArray<{
  op: Method;
  summary: string;
  schema: z.ZodObject;
  bodyLimit?: number;
}> = [
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
  {
    op: 'conflicts',
    summary: 'Conflicts between memories of a scope, open ones by default',
    schema: conflictsSchema,
  },
  {
    op: 'resolve',
    summary: "Resolve a conflict: keep a, b or both; the loser's validity ends",
    schema: resolveSchema,
  },
  {
    op: 'trust',
    summary: 'Set the trust of memories (release or quarantine)',
    schema: trustSchema,
  },
  { op: 'branch', summary: 'Create a branch that reads main as of now', schema: branchSchema },
  { op: 'branches', summary: 'Branches of a scope, open and closed', schema: branchesSchema },
  { op: 'diff', summary: 'What a branch added, forgot and changed', schema: branchSchema },
  { op: 'merge', summary: 'Merge a branch into main under a conflict policy', schema: mergeSchema },
  { op: 'drop', summary: 'Drop a branch and its memories', schema: branchSchema },
  {
    op: 'pin',
    summary: 'Pin or unpin memories (pinned ones never go cold)',
    schema: pinSchema,
  },
  {
    op: 'consolidate',
    summary: 'Run consolidation workers for a scope now',
    schema: consolidateSchema,
  },
  {
    op: 'jobs',
    summary: "A scope's background jobs and lifecycle counts",
    schema: jobsSchema,
  },
  {
    op: 'export',
    summary: 'Export a scope as a .mcube archive (base64), optionally as of a past state',
    schema: exportSchema,
  },
  {
    op: 'import',
    summary: 'Import a .mcube or COGX archive (base64) into a scope',
    schema: importSchema,
    bodyLimit: IMPORT_BODY_LIMIT,
  },
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
        ...(route.bodyLimit ? { bodyLimit: route.bodyLimit } : {}),
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
