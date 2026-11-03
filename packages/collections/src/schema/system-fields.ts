import { err, mindlogError, ok } from '@mindlog/core';
import type { MindlogError, Result } from '@mindlog/core';
import type { FieldInfo, FieldKind, SchemaView } from '@mindlog/rules';
import type { CollectionSchema, FieldDef } from './collection-schema.js';

/** Fields every record has; they live in the key and `StoredRecord`, not in the record JSON. */
export const SYSTEM_FIELDS = ['id', 'created', 'updated', 'collectionName'] as const;

/** Fields every auth collection has (PLAN 16.1), stored in the record JSON. */
export const AUTH_FIELDS: readonly FieldDef[] = [
  { name: 'email', type: 'email', required: false, hidden: false, onlyDomains: [] },
  { name: 'emailVisibility', type: 'bool', required: false, hidden: false },
  { name: 'verified', type: 'bool', required: false, hidden: false },
  { name: 'password', type: 'password', required: true, hidden: true, min: 8 },
  { name: 'tokenKey', type: 'text', required: true, hidden: true, min: 0, max: 0, pattern: '' },
];

/** Fields the record JSON may hold: the schema's own, plus the auth fields. */
export function storedFields(schema: CollectionSchema): readonly FieldDef[] {
  return schema.type === 'auth' ? [...AUTH_FIELDS, ...schema.fields] : schema.fields;
}

/** Select, file and relation fields with `maxSelect > 1` hold arrays. */
export function isMulti(field: FieldDef): boolean {
  return (
    (field.type === 'select' || field.type === 'file' || field.type === 'relation') &&
    field.maxSelect > 1
  );
}

const INDEXABLE: ReadonlySet<string> = new Set([
  'text',
  'number',
  'bool',
  'email',
  'url',
  'date',
  'autodate',
  'select',
  'relation',
  'memory',
]);

/** Structural checks a schema must pass before it is stored. */
export function checkSchema(schema: CollectionSchema): Result<CollectionSchema, MindlogError> {
  const fields: Record<string, string> = {};
  const all = storedFields(schema);
  const names = new Set<string>();
  for (const [i, f] of schema.fields.entries()) {
    if (
      (SYSTEM_FIELDS as readonly string[]).includes(f.name) ||
      AUTH_FIELDS.some((a) => a.name === f.name)
    ) {
      fields[`fields.${String(i)}.name`] = `${f.name} is a system field`;
    }
    if (names.has(f.name)) fields[`fields.${String(i)}.name`] = `duplicate field ${f.name}`;
    names.add(f.name);
    if (f.type === 'password' && schema.type !== 'auth')
      fields[`fields.${String(i)}.type`] = 'password fields belong to auth collections';
    if (f.type === 'vector') {
      const source = all.find((s) => s.name === f.source);
      if (source?.type !== 'text' && source?.type !== 'editor') {
        fields[`fields.${String(i)}.source`] = 'must name a text or editor field';
      }
    }
    if (f.type === 'text' && f.pattern !== '') {
      try {
        new RegExp(f.pattern);
      } catch {
        fields[`fields.${String(i)}.pattern`] = 'invalid regular expression';
      }
    }
  }
  const indexNames = new Set<string>();
  for (const [i, index] of schema.indexes.entries()) {
    if (indexNames.has(index.name))
      fields[`indexes.${String(i)}.name`] = `duplicate index ${index.name}`;
    indexNames.add(index.name);
    for (const name of index.fields) {
      const f = all.find((x) => x.name === name);
      if (name === 'id' || name === 'created' || name === 'updated') continue;
      if (f === undefined) fields[`indexes.${String(i)}.fields`] = `unknown field ${name}`;
      else if (!INDEXABLE.has(f.type) || isMulti(f)) {
        fields[`indexes.${String(i)}.fields`] = `${name} cannot be indexed`;
      }
    }
  }
  if (schema.type === 'view' && schema.view === undefined)
    fields['view'] = 'a view collection needs a view pipeline';
  if (schema.type !== 'view' && schema.view !== undefined)
    fields['view'] = 'only view collections have a pipeline';
  if (schema.type !== 'auth' && (schema.manageRule !== null || schema.auth !== undefined)) {
    fields['type'] = 'manageRule and auth options belong to auth collections';
  }
  if (Object.keys(fields).length > 0) {
    return err(mindlogError('INVALID_ARGUMENT', 'invalid collection schema', { fields }));
  }
  return ok(
    schema.type === 'auth' && schema.auth === undefined ? withAuthDefaults(schema) : schema,
  );
}

/** Auth collections always get a unique email index and default auth options. */
function withAuthDefaults(schema: CollectionSchema): CollectionSchema {
  return {
    ...schema,
    auth: {
      password: { enabled: true },
      otp: { enabled: false, durationS: 300, length: 6 },
      oauth2: { enabled: false, providers: [] },
      requireVerified: false,
    },
  };
}

/** The indexes apply maintains, including the implicit unique email index of auth collections. */
export function indexesOf(schema: CollectionSchema): CollectionSchema['indexes'] {
  if (schema.type !== 'auth' || schema.indexes.some((i) => i.name === '_email'))
    return schema.indexes;
  return [{ name: '_email', fields: ['email'], unique: true }, ...schema.indexes];
}

function kindOf(field: FieldDef): FieldKind {
  return field.type;
}

/** A field as `@mindlog/rules` sees it. */
export function fieldInfo(field: FieldDef): FieldInfo {
  const info: FieldInfo = {
    name: field.name,
    kind: kindOf(field),
    multi: isMulti(field),
    hidden: field.hidden,
  };
  return field.type === 'relation' ? { ...info, collection: field.collection } : info;
}

const SYSTEM_INFO: readonly FieldInfo[] = [
  { name: 'id', kind: 'text', multi: false },
  { name: 'created', kind: 'autodate', multi: false },
  { name: 'updated', kind: 'autodate', multi: false },
  { name: 'collectionName', kind: 'text', multi: false },
];

/** A `SchemaView` over a set of schemas, for checking and evaluating rules. */
export function schemaView(schemas: ReadonlyMap<string, CollectionSchema>): SchemaView {
  return {
    fields: (collection) => {
      const s = schemas.get(collection);
      return s === undefined ? undefined : [...SYSTEM_INFO, ...storedFields(s).map(fieldInfo)];
    },
    collections: () => [...schemas.keys()].sort(),
    authCollections: () =>
      [...schemas.values()].filter((s) => s.type === 'auth').map((s) => s.name),
  };
}
