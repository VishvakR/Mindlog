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
  /** Reads a secret named by `NAME_FILE` or `${file:/path}`. Without it, those are not honoured. */
  readonly readSecret?: (path: string) => string;
}

type Tree = Record<string, unknown>;

const ENV_PREFIX = 'MINDLOG_';
const FILE_SUFFIX = '_FILE';

/**
 * Resolves configuration from layered sources (PLAN 19.6): schema defaults →
 * YAML file (with `${VAR}` interpolation) → `MINDLOG_*` env vars → flags.
 * Pure: no file or process access, so it is trivially testable.
 */
export function resolveConfig(sources: ConfigSources = {}): Result<MindlogConfig, MindlogError> {
  const env = sources.env ?? {};
  const file = parseFile(sources.fileText, env, sources.readSecret);
  if (!file.ok) return file;
  const fromEnv = envOverrides(env, sources.readSecret);
  if (!fromEnv.ok) return fromEnv;
  const merged = [file.value, fromEnv.value, (sources.flags ?? {}) as Tree].reduce(deepMerge);
  const parsed = configSchema.safeParse(merged);
  if (parsed.success) return checkProfile(parsed.data);
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.') || '(root)';
    fields[path] = issue.message;
  }
  return err(mindlogError('CONFIG_INVALID', 'configuration is invalid', { fields }));
}

/** `production` refuses to start without TLS (PLAN 18.4); `dev` leaves it optional. */
function checkProfile(config: MindlogConfig): Result<MindlogConfig, MindlogError> {
  const { tls, profile } = config;
  const missing = (['ca', 'cert', 'key'] as const).filter((f) => tls[f] === undefined);
  const fields: Record<string, string> = {};
  if (tls.enabled)
    for (const f of missing) fields[`tls.${f}`] = 'required when tls.enabled is true';
  if (profile === 'production' && !tls.enabled)
    fields['tls.enabled'] = 'must be true in the production profile';
  if (Object.keys(fields).length > 0)
    return err(mindlogError('CONFIG_INVALID', 'configuration is invalid', { fields }));
  return ok(config);
}

function parseFile(
  text: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  readSecret: ConfigSources['readSecret'],
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
  return interpolate(doc, env, [], readSecret) as Result<Tree, MindlogError>;
}

/** Replaces `${NAME}` with environment variables, and a value of `${file:/path}` with that file. */
function interpolate(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
  path: string[],
  readSecret?: ConfigSources['readSecret'],
): Result<unknown, MindlogError> {
  if (typeof value === 'string') {
    const secretFile = /^\$\{file:(.+)\}$/.exec(value)?.[1];
    if (secretFile !== undefined && readSecret) return loadSecret(readSecret, secretFile);
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
      const r = interpolate(item, env, [...path, String(i)], readSecret);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  }
  if (isTree(value)) {
    const out: Tree = {};
    for (const [k, v] of Object.entries(value)) {
      const r = interpolate(v, env, [...path, k], readSecret);
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
function envOverrides(
  env: Readonly<Record<string, string | undefined>>,
  readSecret: ConfigSources['readSecret'],
): Result<Tree, MindlogError> {
  const out: Tree = {};
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(ENV_PREFIX) || raw === undefined) continue;
    const isFile = readSecret !== undefined && name.endsWith(FILE_SUFFIX);
    const bare = isFile ? name.slice(0, -FILE_SUFFIX.length) : name;
    const path = bare.slice(ENV_PREFIX.length).split('__').map(camelCase);
    if (!CONFIG_SECTIONS.has(path[0] ?? '')) continue;
    if (!isFile) {
      setPath(out, path, parseScalar(raw));
      continue;
    }
    const secret = loadSecret(readSecret, raw);
    if (!secret.ok) return secret;
    setPath(out, path, secret.value);
  }
  return ok(out);
}

function loadSecret(
  readSecret: NonNullable<ConfigSources['readSecret']>,
  path: string,
): Result<string, MindlogError> {
  try {
    return ok(readSecret(path).replace(/\r?\n$/, ''));
  } catch (cause) {
    return err(mindlogError('CONFIG_INVALID', `cannot read secret file ${path}`, { cause }));
  }
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
