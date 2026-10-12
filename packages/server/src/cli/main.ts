import type { MindlogError } from '@mindlog/core';
import { loadConfig } from '../bootstrap/load-config.js';
import { mindlogVersion } from '../bootstrap/server-info.js';
import type { NodeOptions, RunningNode } from '../bootstrap/start-node.js';
import { startNode } from '../bootstrap/start-node.js';
import { USAGE, parseCliArgs } from './args.js';

export interface MainIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Overrides for tests (logger, metrics, clock). */
  readonly node?: NodeOptions;
}

/** A started node, or the exit code to use when nothing was started. */
export type MainResult =
  | { readonly kind: 'running'; readonly node: RunningNode }
  | { readonly kind: 'exit'; readonly code: number };

/** Exit codes (sysexits.h): usage and configuration errors are distinct. */
export const EXIT = { ok: 0, failure: 1, usage: 64, config: 78 } as const;

export function formatError(error: MindlogError): string {
  const fields = Object.entries(error.fields ?? {}).map(([k, v]) => `\n  ${k}: ${v}`);
  return `mindlog-server: ${error.message}${fields.join('')}\n`;
}

const exit = (code: number): MainResult => ({ kind: 'exit', code });

/** `mindlog-server [options]`: parses arguments, loads config and starts the node. */
export async function main(argv: readonly string[], io: MainIo): Promise<MainResult> {
  const args = parseCliArgs(argv);
  if (!args.ok) {
    io.stderr(`${formatError(args.error)}\n${USAGE}\n`);
    return exit(EXIT.usage);
  }
  if (args.value.help) {
    io.stdout(`${USAGE}\n`);
    return exit(EXIT.ok);
  }
  if (args.value.version) {
    io.stdout(`mindlog-server ${mindlogVersion()}\n`);
    return exit(EXIT.ok);
  }
  if (!args.value.singleNode) {
    io.stderr('mindlog-server: clustering arrives in phase 3; run with --single-node\n');
    return exit(EXIT.usage);
  }
  const config = await loadConfig({
    cwd: io.cwd,
    env: io.env,
    configPath: args.value.configPath,
    flags: args.value.flags,
  });
  if (!config.ok) {
    io.stderr(formatError(config.error));
    return exit(EXIT.config);
  }
  const node = await startNode(config.value, io.node);
  if (!node.ok) {
    io.stderr(formatError(node.error));
    return exit(EXIT.failure);
  }
  return { kind: 'running', node: node.value };
}
