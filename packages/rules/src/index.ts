/**
 * @mindlog/rules — the PocketBase-compatible filter and access-rule language
 * (PLAN 16.3, ADR-0018). Pure: schemas and records come in through ports.
 */
export type {
  CallNode,
  CompareNode,
  CompareOp,
  Expr,
  IdentNode,
  IdentRoot,
  Literal,
  LiteralNode,
  LogicNode,
  MacroNode,
  Modifier,
  Operand,
  RuleIssue,
  Span,
} from './ast.js';
export {
  COMPARE_OPS,
  MODIFIERS,
  baseOp,
  comparisons,
  conjuncts,
  identsOf,
  isAnyOp,
} from './ast.js';
export type { Token, TokenKind } from './lexer.js';
export { tokenize } from './lexer.js';
export { MAX_COMPARISONS, parseRule } from './parser.js';
export { printOperand, printRule } from './print.js';
export { ParseCache } from './parse-cache.js';
export type { FieldInfo, FieldKind, SchemaView } from './schema.js';
export { FIELD_KINDS, fieldOf } from './schema.js';
export type { CheckOptions } from './checker.js';
export { checkRule } from './checker.js';
export type { Completion, Completions } from './complete.js';
export { completeRule } from './complete.js';
export type { EvalInput, RecordData, RecordResolver, RequestInfo, RowHint } from './evaluator.js';
export {
  MAX_ALIAS_ROWS,
  MAX_BINDINGS,
  MAX_HOPS,
  evaluateRule,
  operandValues,
} from './evaluator.js';
export type { IndexInfo, RangeOp, ScanPlan } from './planner.js';
export { planScan } from './planner.js';
export { compareValues } from './values.js';
export { MACROS, formatDate, macroValue } from './macros.js';
export { FUNCTIONS, geoDistance, parseTime, strftime } from './functions.js';
