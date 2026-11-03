import type { FieldDef, FieldType } from '../schema/collection-schema.js';

/** Field types as plugins (PocketBase `core/field.go`): one spec per type, in a registry. */
export interface FieldSpec<T extends FieldType = FieldType> {
  readonly type: T;
  /** The value of a field the record does not set. */
  zero(field: Extract<FieldDef, { type: T }>): unknown;
  /**
   * Lenient conversion of client input (JSON or form text) to the stored form,
   * on the leader before proposing. Returns `undefined` when it cannot convert.
   */
  normalize(field: Extract<FieldDef, { type: T }>, value: unknown): unknown;
  /** Strict check of a stored value, also run in apply: a message, or `undefined` if valid. */
  validate(field: Extract<FieldDef, { type: T }>, value: unknown): string | undefined;
}

export const isString = (v: unknown): v is string => typeof v === 'string';

/** Form posts send every value as text; arrays may come as one value or several. */
export function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

/** Single or multi value of select, file and relation fields. */
export function selectShape(maxSelect: number, values: readonly string[]): string | string[] {
  return maxSelect > 1 ? [...new Set(values)] : (values[values.length - 1] ?? '');
}

export function checkSelect(
  maxSelect: number,
  required: boolean,
  value: unknown,
  each: (v: string) => string | undefined,
): string | undefined {
  const list = maxSelect > 1 ? value : value === '' ? [] : [value];
  if (!Array.isArray(list) || !list.every(isString))
    return maxSelect > 1 ? 'must be a list of strings' : 'must be a string';
  if (list.length > maxSelect) return `at most ${String(maxSelect)} values`;
  if (new Set(list).size !== list.length) return 'values must be unique';
  if (required && list.length === 0) return 'cannot be blank';
  for (const v of list) {
    const problem = each(v);
    if (problem !== undefined) return problem;
  }
  return undefined;
}
