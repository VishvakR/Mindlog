import { comparisons, identsOf } from './ast.js';
import type { CallNode, Expr, IdentNode, Operand, RuleIssue } from './ast.js';
import { FUNCTIONS, isModifier } from './functions.js';
import { MACROS } from './macros.js';
import { MAX_HOPS } from './evaluator.js';
import { fieldOf, isObjectKind } from './schema.js';
import type { FieldInfo, SchemaView } from './schema.js';

export interface CheckOptions {
  readonly collection: string;
  readonly schema: SchemaView;
  /** Superuser filters and admin-written rules may read hidden fields. */
  readonly allowHidden: boolean;
}

/** Type-checks a parsed rule against the schemas; an empty list means it is valid. */
export function checkRule(expr: Expr, options: CheckOptions): RuleIssue[] {
  const issues: RuleIssue[] = [];
  for (const cmp of comparisons(expr)) {
    for (const operand of [cmp.left, cmp.right]) checkOperand(operand, options, issues);
  }
  return issues;
}

function checkOperand(operand: Operand, options: CheckOptions, issues: RuleIssue[]): void {
  if (operand.kind === 'macro' && !(MACROS as readonly string[]).includes(operand.name)) {
    issues.push(issue(operand, `unknown macro ${operand.name}`));
  }
  if (operand.kind === 'call') checkCall(operand, options, issues);
  for (const ident of identsOf(operand)) {
    const message = identProblem(ident, options);
    if (message !== undefined) issues.push(issue(ident, message));
  }
}

function checkCall(node: CallNode, options: CheckOptions, issues: RuleIssue[]): void {
  const arity = FUNCTIONS[node.name];
  if (arity === undefined) {
    issues.push(issue(node, `unknown function ${node.name}`));
    return;
  }
  if (node.args.length < arity.min || node.args.length > arity.max) {
    issues.push(
      issue(node, `${node.name} takes ${String(arity.min)}–${String(arity.max)} arguments`),
    );
  }
  if (node.name === 'strftime') {
    const [format, , ...mods] = node.args;
    if (format?.kind !== 'literal' || typeof format.value !== 'string') {
      issues.push(issue(node, 'strftime needs a quoted format first'));
    }
    for (const m of mods) {
      if (m.kind !== 'literal' || typeof m.value !== 'string' || !isModifier(m.value)) {
        issues.push(issue(m, 'unsupported strftime modifier'));
      }
    }
  }
  for (const arg of node.args)
    if (arg.kind === 'call' || arg.kind === 'macro') checkOperand(arg, options, issues);
}

const issue = (span: { from: number; to: number }, message: string): RuleIssue => ({
  message,
  from: span.from,
  to: span.to,
});

function identProblem(ident: IdentNode, options: CheckOptions): string | undefined {
  const { schema, collection } = options;
  const root = ident.root;
  let walked: WalkResult;
  if (root.kind === 'record') {
    walked = walkPath(schema, collection, ident.path, options.allowHidden);
  } else if (root.kind === 'collection') {
    if (schema.fields(root.collection) === undefined)
      return `unknown collection ${root.collection}`;
    walked = walkPath(schema, root.collection, ident.path, options.allowHidden);
  } else {
    const result = requestProblem(ident, options);
    if (typeof result === 'string') return result;
    walked = result;
  }
  if (typeof walked === 'string') return walked;
  return modifierProblem(ident, walked);
}

/** The last field reached (`null` for values without a schema field), or a problem. */
type WalkResult = FieldInfo | null | string;

function requestProblem(ident: IdentNode, options: CheckOptions): WalkResult {
  const [section = '', ...rest] = ident.path;
  switch (section) {
    case 'method':
    case 'context':
      return rest.length === 0 ? null : `@request.${section} has no fields`;
    case 'query':
    case 'headers':
      return rest.length === 1 ? null : `expected @request.${section}.<name>`;
    case 'auth': {
      if (rest.length === 0) return 'expected @request.auth.<field>';
      const auths = options.schema.authCollections();
      if (auths.length === 0) return 'there are no auth collections';
      let first: WalkResult = `unknown field ${rest.join('.')} in the auth collections`;
      for (const name of auths) {
        const result = walkPath(options.schema, name, rest, options.allowHidden);
        if (typeof result !== 'string') return result;
        if (rest.length > 1) first = result;
      }
      return first;
    }
    case 'body': {
      if (rest.length === 0) return 'expected @request.body.<field>';
      return walkPath(options.schema, options.collection, rest, true);
    }
    default:
      return `unknown @request.${section}; expected auth, body, query, headers, method or context`;
  }
}

function walkPath(
  schema: SchemaView,
  collection: string,
  path: readonly string[],
  hidden: boolean,
): WalkResult {
  let current = collection;
  for (let i = 0; i < path.length; i++) {
    const name = path[i] ?? '';
    const field = fieldOf(schema, current, name);
    if (field === undefined) return `unknown field ${name} in ${current}`;
    if (field.hidden === true && !hidden) return `${name} cannot be filtered on`;
    if (i === path.length - 1 || isObjectKind(field.kind)) return field;
    if (field.kind !== 'relation' || field.collection === undefined)
      return `${name} is not a relation field`;
    if (i >= MAX_HOPS) return `more than ${String(MAX_HOPS)} relation hops`;
    current = field.collection;
  }
  return null;
}

function modifierProblem(ident: IdentNode, field: FieldInfo | null): string | undefined {
  const section = ident.root.kind === 'request' ? ident.path[0] : undefined;
  switch (ident.modifier) {
    case 'isset':
      return ['body', 'query', 'headers'].includes(section ?? '') && ident.path.length === 2
        ? undefined
        : ':isset works on @request.body, query and headers fields only';
    case 'changed':
      return section === 'body' && ident.path.length === 2
        ? undefined
        : ':changed works on @request.body fields only';
    case 'length':
    case 'each':
      return field?.multi === true || section === 'body'
        ? undefined
        : `:${ident.modifier} needs a multi-value field`;
    default:
      return undefined;
  }
}
