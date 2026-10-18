import type { MemoryScope } from '../types.js';

/**
 * Whether a memory at (agent, session) belongs to `scope` (PLAN 5.5). A level
 * the scope leaves out matches anything below it; with `inherit` the scope's
 * ancestors match too (session → agent → user).
 */
export function matchesScope(
  memory: { readonly agent: string; readonly session: string },
  scope: MemoryScope,
  inherit: boolean,
): boolean {
  if (!scope.agent) return true;
  if (memory.agent === scope.agent) {
    if (!scope.session || memory.session === scope.session) return true;
    return inherit && memory.session === '';
  }
  return inherit && memory.agent === '' && memory.session === '';
}
