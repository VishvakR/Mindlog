import type { MindlogError, Result } from '@mindlog/core';
import type { MemoryView } from '@mindlog/memory';
import type { MemoryService } from '@mindlog/services';
import { z } from 'zod';

// What every MCP tool module shares (PLAN 15.2).

/** What the MCP adapter uses of the memory service (CLAUDE.md §3.3: narrow ports). */
export type McpMemory = Pick<
  MemoryService,
  | 'remember'
  | 'recall'
  | 'get'
  | 'list'
  | 'forget'
  | 'history'
  | 'graph'
  | 'cacheLookup'
  | 'cacheStore'
  | 'conflicts'
  | 'resolve'
>;

export const when = z
  .string()
  .min(4)
  .max(40)
  .describe('ISO 8601 date or date-time, e.g. 2026-03-01 or 2026-03-01T12:00:00Z');

export const scopeFields = {
  user: z
    .string()
    .max(128)
    .optional()
    .describe("User scope; defaults to the API key's user, or the tenant-wide scope"),
  agent: z.string().min(1).max(128).optional().describe('Agent scope under the user'),
  session: z.string().min(1).max(128).optional().describe('Session scope under the agent'),
};

export type ScopeArgs = {
  user?: string | undefined;
  agent?: string | undefined;
  session?: string | undefined;
};

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function summary(memory: MemoryView): Record<string, unknown> {
  return { id: memory.id, kind: memory.kind, text: memory.text, trust: memory.trust };
}

/** Resolves and authorizes the scope of a tool call, runs it and renders its result or error. */
export type RunTool = <T>(
  args: ScopeArgs,
  call: (scope: {
    user: string;
    agent?: string;
    session?: string;
  }) => Promise<Result<T, MindlogError>>,
  render: (value: T) => { text: string; data: Record<string, unknown> },
) => Promise<ToolResult>;
