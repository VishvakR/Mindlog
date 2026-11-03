import { MODIFIERS } from './ast.js';
import { FUNCTIONS } from './functions.js';
import { MACROS } from './macros.js';
import type { FieldInfo, SchemaView } from './schema.js';

export interface Completion {
  readonly label: string;
  readonly detail: string;
}

/** Suggestions for the identifier ending at `cursor`, replacing source `[from, to)`. */
export interface Completions {
  readonly from: number;
  readonly to: number;
  readonly items: readonly Completion[];
}

const REQUEST_SECTIONS = ['auth.', 'body.', 'query.', 'headers.', 'method', 'context'];
const MAX_ITEMS = 50;

/** Autocomplete for the dashboard's rule editor. */
export function completeRule(
  source: string,
  cursor: number,
  collection: string,
  schema: SchemaView,
): Completions {
  let start = cursor;
  while (start > 0 && /[A-Za-z0-9_.:@]/.test(source.charAt(start - 1))) start--;
  const word = source.slice(start, cursor);
  const dot = word.lastIndexOf('.');
  const segments = word.split('.');
  const colon = word.indexOf(':', dot + 1);
  // `@collection.name:alias` puts a colon in the second segment; everywhere else it starts a modifier.
  const isAlias = segments[0] === '@collection' && segments.length === 2;
  if (colon !== -1 && !isAlias) {
    const typed = word.slice(colon + 1);
    const items = MODIFIERS.filter((m) => m.startsWith(typed)).map((m) => ({
      label: m,
      detail: 'modifier',
    }));
    return { from: start + colon + 1, to: cursor, items };
  }
  const head = dot === -1 ? '' : word.slice(0, dot + 1);
  const typed = word.slice(dot + 1);
  const items = candidates(head, collection, schema)
    .filter((c) => c.label.startsWith(typed))
    .slice(0, MAX_ITEMS);
  return { from: start + head.length, to: cursor, items };
}

function candidates(head: string, collection: string, schema: SchemaView): Completion[] {
  if (head === '') {
    return [
      ...fieldsOf(schema.fields(collection) ?? []),
      { label: '@request.', detail: 'the request' },
      { label: '@collection.', detail: 'another collection' },
      ...MACROS.map((m) => ({ label: m, detail: 'date macro' })),
      ...Object.keys(FUNCTIONS).map((f) => ({ label: `${f}(`, detail: 'function' })),
    ];
  }
  if (head === '@request.') return REQUEST_SECTIONS.map((s) => ({ label: s, detail: '@request' }));
  if (head === '@collection.') {
    return schema.collections().map((c) => ({ label: `${c}.`, detail: 'collection' }));
  }
  const parts = head.slice(0, -1).split('.');
  let fields: readonly FieldInfo[] | undefined;
  let rest: string[];
  if (parts[0] === '@request' && parts[1] === 'auth') {
    fields = schema.authCollections().flatMap((c) => schema.fields(c) ?? []);
    rest = parts.slice(2);
  } else if (parts[0] === '@request' && parts[1] === 'body') {
    fields = schema.fields(collection);
    rest = parts.slice(2);
  } else if (parts[0] === '@collection') {
    fields = schema.fields((parts[1] ?? '').split(':')[0] ?? '');
    rest = parts.slice(2);
  } else {
    fields = schema.fields(collection);
    rest = parts;
  }
  for (const name of rest) {
    const field = fields?.find((f) => f.name === name);
    if (field?.kind !== 'relation' || field.collection === undefined) return [];
    fields = schema.fields(field.collection);
  }
  return fieldsOf(fields ?? []);
}

function fieldsOf(fields: readonly FieldInfo[]): Completion[] {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const f of fields) {
    if (f.hidden === true || seen.has(f.name)) continue;
    seen.add(f.name);
    out.push({
      label: f.kind === 'relation' ? `${f.name}.` : f.name,
      detail: f.multi ? `${f.kind} (multi)` : f.kind,
    });
    if (f.kind === 'relation') out.push({ label: f.name, detail: f.kind });
  }
  return out;
}
