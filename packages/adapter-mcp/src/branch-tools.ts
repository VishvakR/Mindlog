import type { McpServer } from '@modelcontextprotocol/server';
import { MERGE_POLICIES } from '@mindlog/memory';
import { z } from 'zod';
import type { McpMemory, RunTool } from './tool-kit.js';
import { scopeFields, summary } from './tool-kit.js';

const name = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .describe('Branch name, e.g. trip-plan');

/** Memory branch tools (PLAN 13.1, ADR-0013): try a plan on a copy of memory, then keep or drop it. */
export function registerBranchTools(
  server: McpServer,
  memory: McpMemory,
  run: RunTool,
  caller: { tenant: string; principal: string },
): void {
  server.registerTool(
    'branch_create',
    {
      description:
        'Start a branch of memory to try a plan without changing what other agents see. Remember and ' +
        'recall with branch=<name> to work on it; it sees main memory as it is now plus its own changes. ' +
        'Merge it with branch_merge if the plan works out, or drop it with branch_drop.',
      inputSchema: z.object({ name, ...scopeFields }),
      outputSchema: z.object({ name: z.string() }),
    },
    (args) =>
      run(
        args,
        (scope) => memory.createBranch(caller, { scope, name: args.name }),
        () => ({ text: `Branch ${args.name} created.`, data: { name: args.name } }),
      ),
  );

  server.registerTool(
    'branch_diff',
    {
      description:
        'Show what a branch added, forgot and changed compared with main memory when it was created.',
      inputSchema: z.object({ name, ...scopeFields }),
      outputSchema: z.object({
        added: z.array(z.record(z.string(), z.unknown())),
        forgotten: z.array(z.record(z.string(), z.unknown())),
        changed: z.array(z.record(z.string(), z.unknown())),
      }),
    },
    (args) =>
      run(
        args,
        (scope) => memory.diffBranch(caller, { scope, name: args.name }),
        (d) => ({
          text: `${String(d.added.length)} added, ${String(d.forgotten.length)} forgotten, ${String(d.changed.length)} changed.`,
          data: {
            added: d.added.slice(0, 20).map(summary),
            forgotten: d.forgotten.slice(0, 20).map(summary),
            changed: d.changed.slice(0, 20).map(summary),
          },
        }),
      ),
  );

  server.registerTool(
    'branch_merge',
    {
      description:
        "Merge a branch into main memory. New facts that contradict main are checked: policy 'raise' " +
        "(default) adds them quarantined and opens conflicts for a human, 'prefer_branch' lets them " +
        "replace main's facts, 'prefer_main' leaves them out, and 'abort' merges nothing if any conflict.",
      inputSchema: z.object({
        name,
        policy: z.enum(MERGE_POLICIES).optional(),
        ...scopeFields,
      }),
      outputSchema: z.object({
        merged: z.boolean(),
        added: z.array(z.string()),
        rejected: z.array(z.string()),
        conflicts: z.int(),
      }),
    },
    (args) =>
      run(
        args,
        (scope) =>
          memory.mergeBranch(caller, {
            scope,
            name: args.name,
            ...(args.policy ? { policy: args.policy } : {}),
          }),
        (r) => ({
          text: r.merged
            ? `Merged: ${String(r.added.length)} added, ${String(r.conflicts.length)} conflicts.`
            : `Not merged: ${String(r.conflicts.length)} contradictions with main.`,
          data: {
            merged: r.merged,
            added: [...r.added],
            rejected: [...r.rejected],
            conflicts: r.conflicts.length,
          },
        }),
      ),
  );

  server.registerTool(
    'branch_drop',
    {
      description: 'Abandon a branch: its changes are discarded and main memory is untouched.',
      inputSchema: z.object({ name, ...scopeFields }),
      outputSchema: z.object({ name: z.string() }),
    },
    (args) =>
      run(
        args,
        (scope) => memory.dropBranch(caller, { scope, name: args.name }),
        () => ({ text: `Branch ${args.name} dropped.`, data: { name: args.name } }),
      ),
  );
}
