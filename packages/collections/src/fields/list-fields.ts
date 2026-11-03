import type { FieldSpec } from './field-spec.js';
import { asList, checkSelect, isString, selectShape } from './field-spec.js';

const strings = (v: unknown): string[] | undefined => {
  const list = asList(v);
  return list.every(isString) ? list : undefined;
};

export const selectField: FieldSpec<'select'> = {
  type: 'select',
  zero: (f) => (f.maxSelect > 1 ? [] : ''),
  normalize: (f, v) => {
    const list = strings(v);
    return list === undefined ? undefined : selectShape(f.maxSelect, list);
  },
  validate: (f, v) =>
    checkSelect(f.maxSelect, f.required, v, (x) =>
      f.values.includes(x) ? undefined : `${x} is not an allowed value`,
    ),
};

/** Record ids: 15 characters of [a-z0-9] (PocketBase), or ULIDs. */
export const RECORD_ID = /^(?:[a-z0-9]{15}|[0-9A-HJKMNP-TV-Z]{26})$/;

export const relationField: FieldSpec<'relation'> = {
  type: 'relation',
  zero: (f) => (f.maxSelect > 1 ? [] : ''),
  normalize: (f, v) => {
    const list = strings(v);
    return list === undefined ? undefined : selectShape(f.maxSelect, list);
  },
  validate(f, v) {
    const problem = checkSelect(f.maxSelect, f.required, v, (x) =>
      RECORD_ID.test(x) ? undefined : `${x} is not a record id`,
    );
    if (problem !== undefined) return problem;
    const n = Array.isArray(v) ? v.length : v === '' ? 0 : 1;
    return n > 0 && n < f.minSelect ? `at least ${String(f.minSelect)} values` : undefined;
  },
};

/** Stored file names: `<base>_<10 random chars>.<ext>`, safe for URLs and blob keys. */
export const FILE_NAME = /^[A-Za-z0-9._-]{1,150}$/;

export const fileField: FieldSpec<'file'> = {
  type: 'file',
  zero: (f) => (f.maxSelect > 1 ? [] : ''),
  normalize: (f, v) => {
    const list = strings(v);
    return list === undefined ? undefined : selectShape(f.maxSelect, list);
  },
  validate: (f, v) =>
    checkSelect(f.maxSelect, f.required, v, (x) =>
      FILE_NAME.test(x) && !x.startsWith('.') ? undefined : `${x} is not a file name`,
    ),
};
