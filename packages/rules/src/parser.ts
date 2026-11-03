import { err, ok } from '@mindlog/core';
import type { Result } from '@mindlog/core';
import { MODIFIERS } from './ast.js';
import type {
  CompareOp,
  Expr,
  IdentNode,
  IdentRoot,
  Modifier,
  Operand,
  RuleIssue,
  Span,
} from './ast.js';
import { tokenize } from './lexer.js';
import type { Token } from './lexer.js';

/** At most this many comparisons per expression (ADR-0018). */
export const MAX_COMPARISONS = 200;
const MAX_DEPTH = 32;

class ParseError extends Error {
  constructor(readonly issue: RuleIssue) {
    super(issue.message);
  }
}

/** Parses a rule or filter; an empty or comment-only source is an error. */
export function parseRule(source: string): Result<Expr, RuleIssue> {
  const tokens = tokenize(source);
  if (!tokens.ok) return tokens;
  if (tokens.value.length === 1) {
    return err({ message: 'empty expression', from: 0, to: source.length });
  }
  try {
    const parser = new Parser(tokens.value);
    const expr = parser.expression(0);
    parser.expect('eof', 'expected && or || or the end of the expression');
    return ok(expr);
  } catch (e) {
    if (e instanceof ParseError) return err(e.issue);
    throw e;
  }
}

class Parser {
  #at = 0;
  #comparisons = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  expression(depth: number): Expr {
    if (depth > MAX_DEPTH) this.#fail(this.#peek(), 'expression is nested too deeply');
    let left = this.#conjunction(depth);
    while (this.#peek().kind === 'or') {
      this.#at++;
      const right = this.#conjunction(depth);
      left = { kind: 'or', left, right, from: left.from, to: right.to };
    }
    return left;
  }

  expect(kind: Token['kind'], message: string): Token {
    const token = this.#peek();
    if (token.kind !== kind) this.#fail(token, message);
    this.#at++;
    return token;
  }

  #conjunction(depth: number): Expr {
    let left = this.#unary(depth);
    while (this.#peek().kind === 'and') {
      this.#at++;
      const right = this.#unary(depth);
      left = { kind: 'and', left, right, from: left.from, to: right.to };
    }
    return left;
  }

  #unary(depth: number): Expr {
    const token = this.#peek();
    if (token.kind === 'lparen') {
      this.#at++;
      const inner = this.expression(depth + 1);
      const close = this.expect('rparen', 'expected )');
      return { ...inner, from: token.from, to: close.to };
    }
    const left = this.#operand(depth);
    const op = this.expect('op', 'expected an operator such as = or ?=');
    const right = this.#operand(depth);
    if (++this.#comparisons > MAX_COMPARISONS) {
      this.#fail(op, `more than ${String(MAX_COMPARISONS)} comparisons`);
    }
    return {
      kind: 'compare',
      op: op.value as CompareOp,
      left,
      right,
      from: left.from,
      to: right.to,
    };
  }

  #operand(depth: number): Operand {
    const token = this.#peek();
    this.#at++;
    switch (token.kind) {
      case 'text':
        return { kind: 'literal', value: token.value, from: token.from, to: token.to };
      case 'number':
        return { kind: 'literal', value: Number(token.value), from: token.from, to: token.to };
      case 'ident':
        if (this.#peek().kind === 'lparen' && this.#peek().from === token.to) {
          return this.#call(token, depth);
        }
        return identifier(token);
      default:
        this.#at--;
        return this.#fail(token, 'expected a field, a value or a function');
    }
  }

  #call(name: Token, depth: number): Operand {
    if (depth > MAX_DEPTH) this.#fail(name, 'expression is nested too deeply');
    this.#at++; // (
    const args: Operand[] = [];
    if (this.#peek().kind !== 'rparen') {
      args.push(this.#operand(depth + 1));
      while (this.#peek().kind === 'comma') {
        this.#at++;
        args.push(this.#operand(depth + 1));
      }
    }
    const close = this.expect('rparen', 'expected , or ) in the argument list');
    return { kind: 'call', name: name.value, args, from: name.from, to: close.to };
  }

  #peek(): Token {
    // The token list always ends with eof, and #at never moves past it.
    return this.tokens[Math.min(this.#at, this.tokens.length - 1)] as Token;
  }

  #fail(span: Span, message: string): never {
    throw new ParseError({ message, from: span.from, to: span.to });
  }
}

const LITERALS: Readonly<Record<string, boolean | null>> = { true: true, false: false, null: null };

function identifier(token: Token): Operand {
  const span = { from: token.from, to: token.to };
  const lower = token.value.toLowerCase();
  if (lower in LITERALS) return { kind: 'literal', value: LITERALS[lower] ?? null, ...span };
  const fail = (message: string): never => {
    throw new ParseError({ message, ...span });
  };
  const parts = token.value.split('.');
  if (parts.some((p) => p === '')) fail('empty path segment');
  const head = parts[0] ?? '';
  if (head.startsWith('@') && parts.length === 1) {
    if (head.includes(':')) fail('macros take no modifier');
    return { kind: 'macro', name: head, ...span };
  }
  let root: IdentRoot = { kind: 'record' };
  let rest = parts;
  if (head === '@request') {
    root = { kind: 'request' };
    rest = parts.slice(1);
  } else if (head === '@collection') {
    const [collection = '', alias, ...extra] = (parts[1] ?? '').split(':');
    if (collection === '' || extra.length > 0 || alias === '')
      fail('expected @collection.name[:alias].field');
    root = { kind: 'collection', collection, alias: alias ?? collection };
    rest = parts.slice(2);
  } else if (head.startsWith('@')) {
    fail(`unknown identifier ${head}`);
  }
  if (rest.length === 0) fail('expected a field after the prefix');
  return withModifier(root, rest, span, fail);
}

function withModifier(
  root: IdentRoot,
  segments: readonly string[],
  span: Span,
  fail: (message: string) => never,
): IdentNode {
  const path = [...segments];
  const last = path.pop() ?? '';
  const [name = '', modifier, ...extra] = last.split(':');
  if (extra.length > 0 || name === '') fail('a field takes at most one :modifier');
  for (const segment of path)
    if (segment.includes(':')) fail('a :modifier goes on the last field only');
  if (modifier !== undefined && !(MODIFIERS as readonly string[]).includes(modifier)) {
    fail(`unknown modifier :${modifier}`);
  }
  path.push(name);
  const node: IdentNode = { kind: 'ident', root, path, ...span };
  return modifier === undefined ? node : { ...node, modifier: modifier as Modifier };
}
