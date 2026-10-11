import { parse as parseYaml } from 'yaml';
import type { MindlogError } from '../errors/mindlog-error.js';
import { mindlogError } from '../errors/mindlog-error.js';
import type { Result } from '../result/result.js';
import { err, ok } from '../result/result.js';
import type { ConfigOverrides, MindlogConfig } from './config-schema.js';
import { CONFIG_SECTIONS, configSchema } from './config-schema.js';

export interface ConfigSources {
  /** Contents of `mindlog.yaml`, if any. Reading the file is the caller's job. */
  readonly fileText?: string;
  /** Environment, usually `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Highest precedence, e.g. CLI flags. */
  readonly flags?: ConfigOverrides;
}

type Tree = Record<string, unknown>;

const ENV_PREFIX = 'MINDLOG_';

/**
 * Resolves configuration from layered sources (PLAN 19.6): schema defaults →
 * YAML file (with `${VAR}` interpolation) → `MINDLOG_*` env vars → flags.
 * Pure: no file or process access, so it is trivially testable.
 */
export function resolveConfig(sources: ConfigSources = {}): Result<MindlogConfig, MindlogError> {
  const env = sources.env ?? {};
  const file = parseFile(sources.fileText, env);
  if (!file.ok) return file;
  const merged = [file.value, envOverrides(env), (sources.flags ?? {}) as Tree].reduce(deepMerge);
  const parsed = configSchema.safeParse(merged);
  if (parsed.success) return ok(parsed.data);
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.') || '(root)';
    fields[path] = issue.message;
  }
  return err(mindlogError('CONFIG_INVALID', 'configuration is invalid', { fields }));
}

function parseFile(
  text: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Result<Tree, MindlogError> {
  if (text === undefined || text.trim() === '') return ok({});
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (cause) {
    return err(mindlogError('CONFIG_INVALID', 'config file is not valid YAML', { cause }));
  }
  if (!isTree(doc)) {
    return err(mindlogError('CONFIG_INVALID', 'config file must be a YAML mapping'));
  }
  return interpolate(doc, env, []) as Result<Tree, MindlogError>;
}

/** Replaces `${NAME}` in string values with environment variables. */
function interpolate(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
  path: string[],
): Result<unknown, MindlogError> {
  if (typeof value === 'string') {
    let missing: string | undefined;
    const replaced = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
      const found = env[name];
      if (found === undefined) missing = name;
      return found ?? '';
    });
    if (missing === undefined) return ok(replaced);
    return err(
      mindlogError('CONFIG_INVALID', `environment variable ${missing} is not set`, {
        fields: { [path.join('.')]: `references unset variable ${missing}` },
      }),
    );
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const [i, item] of value.entries()) {
      const r = interpolate(item, env, [...path, String(i)]);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  }
  if (isTree(value)) {
    const out: Tree = {};
    for (const [k, v] of Object.entries(value)) {
      const r = interpolate(v, env, [...path, k]);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return ok(out);
  }
  return ok(value);
}

/**
 * `MINDLOG_LISTEN__RESP__PORT=6380` → `{ listen: { resp: { port: 6380 } } }`.
 * Segments are separated by `__` and converted to camelCase; values are parsed
 * as YAML scalars. Vars whose first segment is not a config section (such as
 * `MINDLOG_JOIN_TOKEN`) are interpolation inputs only.
 */
function envOverrides(env: Readonly<Record<string, string | undefined>>): Tree {
  const out: Tree = {};
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(ENV_PREFIX) || raw === undefined) continue;
    const path = name.slice(ENV_PREFIX.length).split('__').map(camelCase);
    if (!CONFIG_SECTIONS.has(path[0] ?? '')) continue;
    setPath(out, path, parseScalar(raw));
  }
  return out;
}

function parseScalar(raw: string): unknown {
  try {
    const value: unknown = parseYaml(raw);
    return value === null || typeof value === 'object' ? raw : value;
  } catch {
    return raw;
  }
}

function camelCase(segment: string): string {
  return segment.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function setPath(tree: Tree, path: string[], value: unknown): void {
  let node = tree;
  for (const [i, key] of path.entries()) {
    if (i === path.length - 1) {
      node[key] = value;
      return;
    }
    const child = node[key];
    if (isTree(child)) {
      node = child;
    } else {
      const created: Tree = {};
      node[key] = created;
      node = created;
    }
  }
}

function deepMerge(base: Tree, override: Tree): Tree {
  const out: Tree = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isTree(current) && isTree(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
