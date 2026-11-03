import { conjuncts, identsOf } from './ast.js';
import type { CompareOp, Expr, Operand } from './ast.js';
import { operandValues } from './evaluator.js';
import type { EvalInput } from './evaluator.js';
import type { FieldKind } from './schema.js';

/** A secondary index over single-valued fields, in key order. */
export interface IndexInfo {
  readonly name: string;
  readonly fields: readonly { readonly name: string; readonly kind: FieldKind }[];
}

export type RangeOp = '>' | '>=' | '<' | '<=';

/**
 * Where a list should read its candidates. The full rule is still evaluated
 * on every candidate, so a plan only has to return a superset of the matches.
 */
export type ScanPlan =
  | { readonly kind: 'scan' }
  | { readonly kind: 'ids'; readonly ids: readonly string[] }
  | {
      readonly kind: 'index';
      readonly index: string;
      /** Values of the index's leading fields, one each. */
      readonly eq: readonly unknown[];
      /** Bounds on the field after them. */
      readonly range?: readonly { readonly op: RangeOp; readonly value: unknown }[];
    };

interface Constraint {
  readonly field: string;
  readonly op: '=' | RangeOp;
  readonly values: readonly unknown[];
}

const FLIP: Readonly<Record<RangeOp, RangeOp>> = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
const TEXT_KINDS: ReadonlySet<FieldKind> = new Set([
  'text',
  'email',
  'url',
  'editor',
  'select',
  'relation',
  'date',
  'autodate',
  'memory',
]);

/** Picks the index that covers the most leading equalities (then a range) of the top-level conjuncts. */
export async function planScan(
  expr: Expr | undefined,
  indexes: readonly IndexInfo[],
  input: EvalInput,
): Promise<ScanPlan> {
  if (expr === undefined) return { kind: 'scan' };
  const constraints = await constraintsOf(expr, input);
  const ids = constraints.find((c) => c.field === 'id' && c.op === '=');
  if (ids !== undefined) return { kind: 'ids', ids: ids.values.map(String) };
  let best: { plan: ScanPlan; score: number } = { plan: { kind: 'scan' }, score: 0 };
  for (const index of indexes) {
    const eq: unknown[] = [];
    let range: { op: RangeOp; value: unknown }[] = [];
    for (const field of index.fields) {
      const equal = constraints.find(
        (c) => c.field === field.name && c.op === '=' && c.values.length === 1,
      );
      const value = equal === undefined ? undefined : indexValue(field.kind, equal.values[0]);
      if (value !== undefined) {
        eq.push(value);
        continue;
      }
      range = constraints
        .filter((c) => c.field === field.name && c.op !== '=' && c.values.length === 1)
        .flatMap((c) => {
          const v = indexValue(field.kind, c.values[0]);
          return v === undefined ? [] : [{ op: c.op as RangeOp, value: v }];
        });
      break;
    }
    const score = eq.length * 2 + (range.length > 0 ? 1 : 0);
    if (score > best.score) {
      const plan: ScanPlan =
        range.length > 0
          ? { kind: 'index', index: index.name, eq, range }
          : { kind: 'index', index: index.name, eq };
      best = { plan, score };
    }
  }
  return best.plan;
}

/** The value as the index stores it, or `undefined` when an index lookup could miss matches. */
function indexValue(kind: FieldKind, value: unknown): unknown {
  if (value === null || value === '' || value === undefined) return undefined;
  if (kind === 'number')
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  if (kind === 'bool') return typeof value === 'boolean' ? value : undefined;
  if (TEXT_KINDS.has(kind)) return typeof value === 'string' ? value : undefined;
  return undefined;
}

async function constraintsOf(expr: Expr, input: EvalInput): Promise<Constraint[]> {
  const out: Constraint[] = [];
  for (const c of conjuncts(expr)) {
    if (c.kind !== 'compare') continue;
    const sides: [Operand, Operand, CompareOp][] = [
      [c.left, c.right, c.op],
      [c.right, c.left, flip(c.op)],
    ];
    for (const [field, other, op] of sides) {
      if (field.kind !== 'ident' || field.root.kind !== 'record' || field.path.length !== 1)
        continue;
      if (field.modifier !== undefined) continue;
      if (
        op !== '=' &&
        op !== '>' &&
        op !== '>=' &&
        op !== '<' &&
        op !== '<=' &&
        !(op === '?=' && field.path[0] === 'id')
      ) {
        continue;
      }
      if (identsOf(other).some((i) => i.root.kind !== 'request')) continue;
      const values = await operandValues(other, input);
      if (!values.ok || values.value.length === 0) continue;
      const name = field.path[0] ?? '';
      if (op === '=' && values.value.length > 1 && name !== 'id') continue;
      out.push({ field: name, op: op === '?=' ? '=' : op, values: values.value });
    }
  }
  return out;
}

function flip(op: CompareOp): CompareOp {
  return op in FLIP ? FLIP[op as RangeOp] : op;
}
