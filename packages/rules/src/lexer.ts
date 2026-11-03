import { err, ok } from '@mindlog/core';
import type { Result } from '@mindlog/core';
import { COMPARE_OPS } from './ast.js';
import type { CompareOp, RuleIssue, Span } from './ast.js';

export type TokenKind =
  'ident' | 'text' | 'number' | 'op' | 'and' | 'or' | 'lparen' | 'rparen' | 'comma' | 'eof';

export interface Token extends Span {
  readonly kind: TokenKind;
  /** Identifier name, decoded text, number source or operator. */
  readonly value: string;
}

// Longest first, so `?!=` wins over `?!` and `!=` over `!`.
const OPS: readonly CompareOp[] = [...COMPARE_OPS].sort((a, b) => b.length - a.length);

const isIdentStart = (c: string): boolean => /[A-Za-z_@]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_.:@]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** Splits a rule into tokens; `//` comments run to the end of the line. */
export function tokenize(source: string): Result<Token[], RuleIssue> {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (source.startsWith('//', i)) {
      while (i < n && source.charAt(i) !== '\n') i++;
      continue;
    }
    const start = i;
    if (source.startsWith('&&', i)) {
      tokens.push({ kind: 'and', value: '&&', from: start, to: (i += 2) });
      continue;
    }
    if (source.startsWith('||', i)) {
      tokens.push({ kind: 'or', value: '||', from: start, to: (i += 2) });
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      const kind = c === '(' ? 'lparen' : c === ')' ? 'rparen' : 'comma';
      tokens.push({ kind, value: c, from: start, to: ++i });
      continue;
    }
    if (c === "'" || c === '"') {
      const text = readText(source, i);
      if (!text.ok) return text;
      tokens.push({ kind: 'text', value: text.value.value, from: start, to: text.value.end });
      i = text.value.end;
      continue;
    }
    if (isDigit(c) || (c === '-' && isDigit(source.charAt(i + 1)))) {
      i++;
      while (i < n && isDigit(source.charAt(i))) i++;
      if (source.charAt(i) === '.' && isDigit(source.charAt(i + 1))) {
        i++;
        while (i < n && isDigit(source.charAt(i))) i++;
      }
      tokens.push({ kind: 'number', value: source.slice(start, i), from: start, to: i });
      continue;
    }
    if (isIdentStart(c)) {
      while (i < n && isIdentPart(source.charAt(i))) i++;
      tokens.push({ kind: 'ident', value: source.slice(start, i), from: start, to: i });
      continue;
    }
    const op = OPS.find((o) => source.startsWith(o, i));
    if (op !== undefined) {
      tokens.push({ kind: 'op', value: op, from: start, to: (i += op.length) });
      continue;
    }
    return err({ message: `unexpected character ${JSON.stringify(c)}`, from: i, to: i + 1 });
  }
  tokens.push({ kind: 'eof', value: '', from: n, to: n });
  return ok(tokens);
}

function readText(source: string, at: number): Result<{ value: string; end: number }, RuleIssue> {
  const quote = source.charAt(at);
  let out = '';
  let i = at + 1;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === '\\' && i + 1 < source.length) {
      const next = source.charAt(i + 1);
      out += next === quote || next === '\\' ? next : c + next;
      i += 2;
      continue;
    }
    if (c === quote) return ok({ value: out, end: i + 1 });
    out += c;
    i++;
  }
  return err({ message: 'unterminated string', from: at, to: source.length });
}
