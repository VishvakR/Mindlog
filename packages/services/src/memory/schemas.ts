import { MEMORY_KINDS, RECIPE_NAMES, SOURCE_TYPES } from '@mindlog/memory';
import { z } from 'zod';

// Memory request schemas (PLAN 15), shared by RESP, REST, MCP and node-to-node forwarding.

const name = z.string().max(128);

export const memoryScopeSchema = z.strictObject({
  /** '' is the tenant-wide scope. */
  user: name.default(''),
  agent: name.min(1).optional(),
  session: name.min(1).optional(),
});

const kind = z.enum(MEMORY_KINDS);

export const rememberSchema = z.strictObject({
  scope: memoryScopeSchema,
  content: z
    .string()
    .min(1)
    .max(64 * 1024),
  kind: kind.optional(),
  source: z
    .strictObject({ type: z.enum(SOURCE_TYPES), ref: z.string().max(512).optional() })
    .optional(),
  async: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const recallSchema = z.strictObject({
  scope: memoryScopeSchema,
  query: z.string().min(1).max(4096),
  k: z.int().min(1).max(50).optional(),
  tokenBudget: z.int().min(1).max(32_000).optional(),
  inherit: z.boolean().optional(),
  kinds: z.array(kind).max(MEMORY_KINDS.length).optional(),
  includeQuarantined: z.boolean().optional(),
  /** Named recall configuration (ADR-0011). */
  recipe: z.enum(RECIPE_NAMES).optional(),
  /** Also return each retriever's ranked ids and the themes found. */
  explain: z.boolean().optional(),
});

const memoryId = z.string().min(1).max(64);

export const getMemorySchema = z.strictObject({ scope: memoryScopeSchema, id: memoryId });

export const listMemorySchema = z.strictObject({
  scope: memoryScopeSchema,
  limit: z.int().min(1).max(200).default(50),
  after: memoryId.optional(),
  kind: kind.optional(),
  includeForgotten: z.boolean().optional(),
});

export const forgetSchema = z.strictObject({
  scope: memoryScopeSchema,
  ids: z.array(memoryId).min(1).max(100),
  reason: z.string().max(500).optional(),
});

export const historySchema = z.strictObject({ scope: memoryScopeSchema, id: memoryId });

export const graphSchema = z.strictObject({
  scope: memoryScopeSchema,
  entity: z.string().min(1).max(256),
  depth: z.int().min(1).max(2).default(1),
});

export const scopesSchema = z.strictObject({ limit: z.int().min(1).max(1000).default(200) });

export type RememberRequest = z.input<typeof rememberSchema>;
export type RecallRequest = z.input<typeof recallSchema>;
export type GetMemoryRequest = z.input<typeof getMemorySchema>;
export type ListMemoryRequest = z.input<typeof listMemorySchema>;
export type ForgetRequest = z.input<typeof forgetSchema>;
export type HistoryRequest = z.input<typeof historySchema>;
export type GraphRequest = z.input<typeof graphSchema>;
export type ScopesRequest = z.input<typeof scopesSchema>;
