import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { MindlogConfig, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, resolveConfig } from '@mindlog/core';

export const DEFAULT_CONFIG_FILE = 'mindlog.yaml';

export interface ConfigInputs {
  /** Explicit `--config` path; it must exist. */
  readonly configPath?: string | undefined;
  /** Directory searched for `mindlog.yaml` when no path is given. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** CLI overrides, highest precedence. */
  readonly flags?: Record<string, unknown>;
}

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';

/**
 * Layers defaults, the config file, `MINDLOG_*` variables and CLI flags
 * (PLAN 19.6). `mindlog.yaml` in `cwd` is optional; an explicit path is not.
 */
export async function loadConfig(
  inputs: ConfigInputs,
): Promise<Result<MindlogConfig, MindlogError>> {
  const path = resolve(inputs.cwd, inputs.configPath ?? DEFAULT_CONFIG_FILE);
  let fileText: string | undefined;
  try {
    fileText = await readFile(path, 'utf8');
  } catch (cause) {
    if (inputs.configPath !== undefined || !isMissing(cause)) {
      return err(mindlogError('CONFIG_INVALID', `cannot read config file ${path}`, { cause }));
    }
  }
  return resolveConfig({
    ...(fileText === undefined ? {} : { fileText }),
    env: inputs.env,
    ...(inputs.flags ? { flags: inputs.flags } : {}),
  });
}
