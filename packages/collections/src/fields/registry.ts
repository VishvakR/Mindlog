import type { FieldDef, FieldType } from '../schema/collection-schema.js';
import type { FieldSpec } from './field-spec.js';
import { fileField, relationField, selectField } from './list-fields.js';
import {
  autodateField,
  dateField,
  editorField,
  emailField,
  memoryField,
  passwordField,
  textField,
  urlField,
} from './text-fields.js';
import { boolField, geoPointField, jsonField, numberField, vectorField } from './value-fields.js';

const SPECS: { readonly [T in FieldType]: FieldSpec<T> } = {
  text: textField,
  number: numberField,
  bool: boolField,
  email: emailField,
  url: urlField,
  editor: editorField,
  date: dateField,
  autodate: autodateField,
  select: selectField,
  file: fileField,
  relation: relationField,
  json: jsonField,
  geoPoint: geoPointField,
  password: passwordField,
  vector: vectorField,
  memory: memoryField,
};

/** The spec of a field's type. */
export function specOf<F extends FieldDef>(field: F): FieldSpec<F['type']> {
  return SPECS[field.type] as FieldSpec<F['type']>;
}

/** Calls through the spec of the field's type. */
export const fieldZero = (field: FieldDef): unknown => specOf(field).zero(field);
export const fieldNormalize = (field: FieldDef, value: unknown): unknown =>
  specOf(field).normalize(field, value);
export const fieldValidate = (field: FieldDef, value: unknown): string | undefined =>
  specOf(field).validate(field, value);
