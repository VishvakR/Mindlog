import type { ConflictView } from '@mindlog/memory';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpMemory, RunTool } from './tool-kit.js';
import { scopeFields, summary, when } from './tool-kit.js';

function conflictData(c: ConflictView): Record<string, unknown> {
  return {
    id: c.id,
    status: c.status,
    a: c.a ? summary(c.a) : null,
    b: c.b ? summary(c.b) : null,
    scores: [...c.scores],
    policy: c.policy,
    ...(c.keep ? { keep: c.keep } : {}),
  };
}

/** Conflict review tools (ADR-0015): agents can see contradictions and settle them when asked. */
export function registerReviewTools(
  server: McpServer,
  memory: McpMemory,
  run: RunTool,
  caller: { tenant: string; principal: string },
): void {
  server.registerTool(
    'conflicts',
    {
      description:
        'List contradictions Mindlog found between remembered facts (an older fact a and a newer fact b). ' +
        'The newer fact is usually quarantined until someone resolves the conflict. Check this when recall ' +
        'seems to be missing something you were told, or before relying on a fact the user may have changed.',
      inputSchema: z.object({
        all: z.boolean().optional().describe('Include resolved conflicts'),
        ...scopeFields,
      }),
      outputSchema: z.object({ conflicts: z.array(z.record(z.string(), z.unknown())) }),
    },
    (args) =>
      run(
        args,
        (scope) =>
          memory.conflicts(caller, { scope, ...(args.all ? { status: 'all' as const } : {}) }),
        (r) => ({
          text:
            r.conflicts.length === 0
              ? 'No conflicts.'
              : r.conflicts
                  .slice(0, 20)
                  .map(
                    (c) => `${c.id} [${c.status}]: "${c.a?.text ?? '?'}" vs "${c.b?.text ?? '?'}"`,
                  )
                  .join('\n'),
          data: { conflicts: r.conflicts.slice(0, 20).map(conflictData) },
        }),
      ),
  );

  server.registerTool(
    'resolve_conflict',
    {
      description:
        'Settle a conflict once the user has said which fact is right: keep a (the older fact), b (the newer ' +
        'one), or both (both true, e.g. one replaced the other at valid_from). Nothing is deleted; the losing ' +
        "fact's validity ends. Do not guess: ask the user first.",
      inputSchema: z.object({
        id: z.string().min(1).max(64).describe('Conflict id from the conflicts tool'),
        keep: z.enum(['a', 'b', 'both']),
        valid_from: when.optional().describe('With keep=both: when b replaced a'),
        ...scopeFields,
      }),
      outputSchema: z.object({ changed: z.array(z.string()) }),
    },
    (args) =>
      run(
        args,
        (scope) =>
          memory.resolve(caller, {
            scope,
            id: args.id,
            keep: args.keep,
            ...(args.valid_from ? { validFrom: args.valid_from } : {}),
          }),
        (r) => ({
          text: `Resolved; ${String(r.count)} memor${r.count === 1 ? 'y' : 'ies'} updated.`,
          data: { changed: r.ids },
        }),
      ),
  );
}
