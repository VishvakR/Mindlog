import { err, mindlogError, ok } from '@mindlog/core';
import type { MindlogError, Result } from '@mindlog/core';
import { z } from 'zod';

/** Collection and field names: letters, digits and `_`; `_`-prefixed collections are system ones. */
export const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const name = z.string().regex(NAME, 'letters, digits and _ only, not starting with a digit');

const base = { name, required: z.boolean().default(false), hidden: z.boolean().default(false) };
const maxSelect = z.number().int().min(1).max(1000).default(1);

/** Field definitions (PLAN 16.2); `maxSelect > 1` makes select, file and relation multi-valued. */
export const fieldSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('text'),
    min: z.number().int().min(0).default(0),
    max: z.number().int().min(0).default(0),
    pattern: z.string().default(''),
  }),
  z.object({
    ...base,
    type: z.literal('number'),
    min: z.number().nullable().default(null),
    max: z.number().nullable().default(null),
    onlyInt: z.boolean().default(false),
  }),
  z.object({ ...base, type: z.literal('bool') }),
  z.object({ ...base, type: z.literal('email'), onlyDomains: z.array(z.string()).default([]) }),
  z.object({ ...base, type: z.literal('url') }),
  z.object({ ...base, type: z.literal('editor'), maxSize: z.number().int().min(0).default(0) }),
  z.object({ ...base, type: z.literal('date') }),
  z.object({
    ...base,
    type: z.literal('autodate'),
    onCreate: z.boolean().default(true),
    onUpdate: z.boolean().default(false),
  }),
  z.object({
    ...base,
    type: z.literal('select'),
    values: z.array(z.string().min(1)).min(1),
    maxSelect,
  }),
  z.object({
    ...base,
    type: z.literal('file'),
    maxSelect,
    maxSize: z
      .number()
      .int()
      .min(0)
      .default(5 * 1024 * 1024),
    mimeTypes: z.array(z.string()).default([]),
    thumbs: z.array(z.string().regex(/^\d{1,4}x\d{1,4}[tbf]?$/)).default([]),
    protected: z.boolean().default(false),
  }),
  z.object({
    ...base,
    type: z.literal('relation'),
    collection: name,
    maxSelect,
    minSelect: z.number().int().min(0).default(0),
    cascadeDelete: z.boolean().default(false),
  }),
  z.object({ ...base, type: z.literal('json'), maxSize: z.number().int().min(0).default(0) }),
  z.object({ ...base, type: z.literal('geoPoint') }),
  z.object({ ...base, type: z.literal('password'), min: z.number().int().min(0).default(8) }),
  z.object({
    ...base,
    type: z.literal('vector'),
    source: name,
    dimensions: z.number().int().min(0).default(0),
  }),
  z.object({ ...base, type: z.literal('memory') }),
]);
export type FieldDef = z.infer<typeof fieldSchema>;
export type FieldType = FieldDef['type'];

const rule = z.string().max(4096).nullable().default(null);

/** View collections: a small JSON pipeline instead of SQL (PLAN 16.7). */
export const viewSchema = z.object({
  from: name,
  join: z
    .array(
      z.object({
        collection: name,
        /** `<joined field> = <from field>`; `id` names the record id. */
        on: z.object({ field: name, equals: name }),
        type: z.enum(['left', 'inner']).default('left'),
      }),
    )
    .max(3)
    .default([]),
  /** Group by these source fields (`collection.field`); empty keeps one row per source record. */
  group: z
    .array(z.string().regex(/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/))
    .max(5)
    .default([]),
  /** Output field → `count(c.f)`, `sum(c.f)`, `avg(c.f)`, `min(c.f)`, `max(c.f)` or `c.f`. */
  select: z.record(name, z.string().max(200)),
});
export type ViewDef = z.infer<typeof viewSchema>;

const authOptions = z.object({
  /** Password sign-in; always available offline. */
  password: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  /** Opt-in (ADR-0035): needs the node's mailer. */
  otp: z
    .object({
      enabled: z.boolean().default(false),
      durationS: z.number().int().min(30).max(3600).default(300),
      length: z.number().int().min(4).max(10).default(6),
    })
    .prefault({}),
  /** Opt-in (ADR-0035): needs provider settings on the node. */
  oauth2: z
    .object({
      enabled: z.boolean().default(false),
      providers: z.array(z.string().regex(/^[a-z0-9_-]{1,32}$/)).default([]),
    })
    .prefault({}),
  /** Unverified users cannot sign in when set (needs the mailer for verification). */
  requireVerified: z.boolean().default(false),
});
export type AuthOptions = z.infer<typeof authOptions>;

export const collectionSchema = z
  .object({
    name,
    type: z.enum(['base', 'auth', 'view']).default('base'),
    fields: z.array(fieldSchema).max(200).default([]),
    indexes: z
      .array(
        z.object({ name, fields: z.array(name).min(1).max(4), unique: z.boolean().default(false) }),
      )
      .max(20)
      .default([]),
    listRule: rule,
    viewRule: rule,
    createRule: rule,
    updateRule: rule,
    deleteRule: rule,
    /** Auth collections: lets a matching user manage other users' auth fields. */
    manageRule: rule,
    view: viewSchema.optional(),
    auth: authOptions.optional(),
  })
  .strict();
export type CollectionSchema = z.infer<typeof collectionSchema>;
export type CollectionInput = z.input<typeof collectionSchema>;

/** Reads and validates a schema; the name rules and field references are checked by `checkSchema`. */
export function parseSchema(raw: unknown): Result<CollectionSchema, MindlogError> {
  const parsed = collectionSchema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues)
      fields[issue.path.join('.') || 'schema'] = issue.message;
    return err(mindlogError('INVALID_ARGUMENT', 'invalid collection schema', { fields }));
  }
  return ok(parsed.data);
}
