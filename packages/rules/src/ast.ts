/** Source offsets `[from, to)` in the rule text, for editor diagnostics. */
export interface Span {
  readonly from: number;
  readonly to: number;
}

/** A problem in a rule, located in its source text. */
export interface RuleIssue extends Span {
  readonly message: string;
}

export const COMPARE_OPS = [
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  '~',
  '!~',
  '?=',
  '?!=',
  '?>',
  '?>=',
  '?<',
  '?<=',
  '?~',
  '?!~',
] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];

export const MODIFIERS = ['isset', 'changed', 'length', 'each', 'lower'] as const;
export type Modifier = (typeof MODIFIERS)[number];

export type Literal = string | number | boolean | null;

/** Where an identifier's path starts. */
export type IdentRoot =
  | { readonly kind: 'record' }
  | { readonly kind: 'request' }
  | { readonly kind: 'collection'; readonly collection: string; readonly alias: string };

export interface IdentNode extends Span {
  readonly kind: 'ident';
  readonly root: IdentRoot;
  /** Path after the root: `['author', 'name']`, `['auth', 'id']`, `['body', 'title']`. */
  readonly path: readonly string[];
  readonly modifier?: Modifier;
}

export interface LiteralNode extends Span {
  readonly kind: 'literal';
  readonly value: Literal;
}

export interface MacroNode extends Span {
  readonly kind: 'macro';
  readonly name: string;
}

export interface CallNode extends Span {
  readonly kind: 'call';
  readonly name: string;
  readonly args: readonly Operand[];
}

export type Operand = IdentNode | LiteralNode | MacroNode | CallNode;

export interface CompareNode extends Span {
  readonly kind: 'compare';
  readonly op: CompareOp;
  readonly left: Operand;
  readonly right: Operand;
}

export interface LogicNode extends Span {
  readonly kind: 'and' | 'or';
  readonly left: Expr;
  readonly right: Expr;
}

export type Expr = CompareNode | LogicNode;

/** `?=`, `?~`, … match when any value matches; the plain forms need every value to. */
export function isAnyOp(op: CompareOp): boolean {
  return op.startsWith('?');
}

/** The plain operator under a `?` prefix. */
export function baseOp(op: CompareOp): CompareOp {
  return (isAnyOp(op) ? op.slice(1) : op) as CompareOp;
}

/** Every comparison in an expression, left to right. */
export function comparisons(expr: Expr): CompareNode[] {
  if (expr.kind === 'compare') return [expr];
  return [...comparisons(expr.left), ...comparisons(expr.right)];
}

/** The top-level conjuncts: `a && (b || c) && d` gives `[a, b || c, d]`. */
export function conjuncts(expr: Expr): Expr[] {
  return expr.kind === 'and' ? [...conjuncts(expr.left), ...conjuncts(expr.right)] : [expr];
}

/** Identifiers inside an operand, including function arguments. */
export function identsOf(operand: Operand): IdentNode[] {
  if (operand.kind === 'ident') return [operand];
  if (operand.kind === 'call') return operand.args.flatMap(identsOf);
  return [];
}
