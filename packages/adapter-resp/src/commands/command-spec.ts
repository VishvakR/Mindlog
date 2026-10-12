import { readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';

export const ARGUMENT_TYPES = [
  'string',
  'integer',
  'double',
  'key',
  'pattern',
  'unix-time',
  'pure-token',
  'oneof',
  'block',
] as const;

export const COMMAND_FLAGS = [
  'WRITE',
  'READONLY',
  'DENYOOM',
  'FAST',
  'NOSCRIPT',
  'LOADING',
  'STALE',
  'NO_AUTH',
] as const;

export interface CommandArgument {
  readonly name: string;
  readonly type: (typeof ARGUMENT_TYPES)[number];
  readonly token?: string | undefined;
  readonly optional?: boolean | undefined;
  readonly multiple?: boolean | undefined;
  readonly arguments?: readonly CommandArgument[] | undefined;
}

export interface KeyRange {
  readonly first: number;
  /** Absolute position of the last key; negative counts from the end. */
  readonly last: number;
  readonly step: number;
}

export interface CommandSpec {
  readonly summary: string;
  readonly complexity: string;
  readonly group: string;
  readonly since: string;
  readonly arity: number;
  readonly command_flags: readonly (typeof COMMAND_FLAGS)[number][];
  readonly key_range?: KeyRange | undefined;
  readonly arguments?: readonly CommandArgument[] | undefined;
  readonly subcommands?: Readonly<Record<string, CommandSpec>> | undefined;
}

const argumentSchema: z.ZodType<CommandArgument> = z.lazy(() =>
  z.strictObject({
    name: z.string().min(1),
    type: z.enum(ARGUMENT_TYPES),
    token: z.string().min(1).optional(),
    optional: z.boolean().optional(),
    multiple: z.boolean().optional(),
    arguments: z.array(argumentSchema).min(1).optional(),
  }),
);

const specSchema: z.ZodType<CommandSpec> = z.lazy(() =>
  z.strictObject({
    summary: z.string().min(1),
    complexity: z.string().min(1),
    group: z.string().min(1),
    since: z.string().regex(/^\d+\.\d+\.\d+$/),
    arity: z.int().refine((n) => n !== 0, 'arity cannot be 0'),
    command_flags: z.array(z.enum(COMMAND_FLAGS)),
    key_range: z
      .strictObject({ first: z.int().positive(), last: z.int(), step: z.int().positive() })
      .optional(),
    arguments: z.array(argumentSchema).optional(),
    subcommands: z.record(z.string().regex(/^[A-Z-]+$/), specSchema).optional(),
  }),
);

const fileSchema = z.record(z.string().regex(/^[A-Z][A-Z.]*$/), specSchema);

/** The spec directory: `commands/` next to `src/` and `dist/`. */
const SPEC_DIR = new URL('../../commands/', import.meta.url);

/**
 * Reads and validates every `commands/*.json` file (Valkey-shaped, written for
 * Mindlog). Throws on an invalid or duplicate spec: specs ship with the code,
 * so a bad one is a programmer error caught at startup and in tests.
 */
export function loadCommandSpecs(dir: URL = SPEC_DIR): ReadonlyMap<string, CommandSpec> {
  const specs = new Map<string, CommandSpec>();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
    if (!parsed.success) throw new Error(`invalid command spec ${file}: ${parsed.error.message}`);
    for (const [name, spec] of Object.entries(parsed.data)) {
      if (specs.has(name)) throw new Error(`command ${name} is specified twice (${file})`);
      specs.set(name, spec);
    }
  }
  return specs;
}
