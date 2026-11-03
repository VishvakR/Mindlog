/** Field kinds of collection schemas (PLAN 16.2), as far as rules care. */
export const FIELD_KINDS = [
  'text',
  'number',
  'bool',
  'email',
  'url',
  'editor',
  'date',
  'autodate',
  'select',
  'file',
  'relation',
  'json',
  'geoPoint',
  'password',
  'vector',
  'memory',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldInfo {
  readonly name: string;
  readonly kind: FieldKind;
  /** Multi select, multi relation, multi file. */
  readonly multi: boolean;
  /** Target collection of a relation field. */
  readonly collection?: string;
  /** Hidden fields (passwords, token keys) cannot be filtered on by non-superusers. */
  readonly hidden?: boolean;
}

/** What rules need to know about the schemas; implemented by `@mindlog/collections`. */
export interface SchemaView {
  /** Fields of a collection, system fields included; `undefined` if it does not exist. */
  fields(collection: string): readonly FieldInfo[] | undefined;
  /** Every collection name, sorted. */
  collections(): readonly string[];
  /** Names of the auth collections, whose records can be `@request.auth`. */
  authCollections(): readonly string[];
}

export function fieldOf(
  schema: SchemaView,
  collection: string,
  name: string,
): FieldInfo | undefined {
  return schema.fields(collection)?.find((f) => f.name === name);
}

/** Kinds whose value can be walked into with more path segments. */
export function isObjectKind(kind: FieldKind): boolean {
  return kind === 'json' || kind === 'geoPoint';
}
