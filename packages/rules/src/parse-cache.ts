import type { Result } from '@mindlog/core';
import type { Expr, RuleIssue } from './ast.js';
import { parseRule } from './parser.js';

const LIMIT = 500;

/** Parsed rules by source text, bounded like PocketBase's (500 entries, oldest dropped). */
export class ParseCache {
  readonly #entries = new Map<string, Result<Expr, RuleIssue>>();

  parse(source: string): Result<Expr, RuleIssue> {
    const hit = this.#entries.get(source);
    if (hit !== undefined) return hit;
    const parsed = parseRule(source);
    if (this.#entries.size >= LIMIT) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
    this.#entries.set(source, parsed);
    return parsed;
  }
}
