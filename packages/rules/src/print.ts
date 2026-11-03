import type { Expr, IdentNode, Literal, Operand } from './ast.js';

/** Prints an expression back to rule syntax; parsing the output gives the same tree. */
export function printRule(expr: Expr): string {
  switch (expr.kind) {
    case 'compare':
      return `${printOperand(expr.left)} ${expr.op} ${printOperand(expr.right)}`;
    case 'and':
    case 'or': {
      const op = expr.kind === 'and' ? '&&' : '||';
      return `(${printRule(expr.left)} ${op} ${printRule(expr.right)})`;
    }
  }
}

export function printOperand(operand: Operand): string {
  switch (operand.kind) {
    case 'literal':
      return printLiteral(operand.value);
    case 'macro':
      return operand.name;
    case 'call':
      return `${operand.name}(${operand.args.map(printOperand).join(', ')})`;
    case 'ident':
      return printIdent(operand);
  }
}

export function printIdent(ident: IdentNode): string {
  const root = ident.root;
  const prefix =
    root.kind === 'request'
      ? ['@request']
      : root.kind === 'collection'
        ? [
            '@collection',
            root.alias === root.collection ? root.collection : `${root.collection}:${root.alias}`,
          ]
        : [];
  const path = [...prefix, ...ident.path].join('.');
  return ident.modifier === undefined ? path : `${path}:${ident.modifier}`;
}

function printLiteral(value: Literal): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return String(value);
}
