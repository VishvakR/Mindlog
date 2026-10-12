import { z } from 'zod';

/** How byte strings travel in JSON: UTF-8 text, or base64 when the bytes are not valid UTF-8. */
export const encodingSchema = z.enum(['utf8', 'base64']);
export type Encoding = z.infer<typeof encodingSchema>;

export const keyTypeSchema = z.enum(['string', 'hash', 'list', 'set', 'zset', 'json']);
export type KeyType = z.infer<typeof keyTypeSchema>;

const text = z.string();
const nonEmpty = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(100_000);

/** A typed Redis value; collections are never empty (Redis deletes empty keys). */
export const keyValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string'), value: text }),
  z.object({
    type: z.literal('hash'),
    value: nonEmpty(z.object({ field: text, value: text })),
  }),
  z.object({ type: z.literal('list'), value: nonEmpty(text) }),
  z.object({ type: z.literal('set'), value: nonEmpty(text) }),
  z.object({
    type: z.literal('zset'),
    value: nonEmpty(z.object({ member: text, score: z.number() })),
  }),
  z.object({ type: z.literal('json'), value: z.json() }),
]);
export type KeyValue = z.infer<typeof keyValueSchema>;

/** Milliseconds until expiry; null means the key never expires. */
const ttlMs = z.number().int().min(1).nullable();

export const writeKeyBodySchema = z.intersection(
  keyValueSchema,
  z.object({ ttlMs: ttlMs.optional(), encoding: encodingSchema.optional() }),
);
export type WriteKeyBody = z.infer<typeof writeKeyBodySchema>;

export const ttlBodySchema = z.object({ ttlMs });
export type TtlBody = z.infer<typeof ttlBodySchema>;

export const scanQuerySchema = z.object({
  cursor: z.string().default('0'),
  match: z.string().max(1024).optional(),
  type: keyTypeSchema.optional(),
  count: z.coerce.number().int().min(1).max(1000).default(100),
});
export type ScanQuery = z.infer<typeof scanQuerySchema>;

export const keyQuerySchema = z.object({
  encoding: encodingSchema.default('utf8'),
  limit: z.coerce.number().int().min(1).max(10_000).default(1000),
});
export type KeyQuery = z.infer<typeof keyQuerySchema>;

export const keySummarySchema = z.object({
  key: text,
  encoding: encodingSchema,
  type: keyTypeSchema,
  ttlMs: z.number().nullable(),
});
export type KeySummary = z.infer<typeof keySummarySchema>;

export const scanResultSchema = z.object({ cursor: z.string(), keys: z.array(keySummarySchema) });
export type ScanResult = z.infer<typeof scanResultSchema>;

export const keyDetailSchema = z.intersection(
  keyValueSchema,
  z.object({
    key: text,
    encoding: encodingSchema,
    ttlMs: z.number().nullable(),
    /** Elements in the collection; above `value.length` when the read was truncated. */
    length: z.number(),
    truncated: z.boolean(),
  }),
);
export type KeyDetail = z.infer<typeof keyDetailSchema>;
