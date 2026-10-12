import type { MindlogError } from '@mindlog/core';
import type { NodeOptions, RunningNode } from '../bootstrap/start-node.js';

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
