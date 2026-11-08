import { createHash } from 'node:crypto';
import type { RecordData } from '@mindlog/rules';
import { compareValues } from '@mindlog/rules';
import type { CollectionSchema, ViewDef } from './schema/collection-schema.js';
import { storedFields } from './schema/system-fields.js';

type Aggregate = 'count' | 'sum' | 'avg' | 'min' | 'max';
type Select =
  | { readonly collection: string; readonly field: string }
  | { readonly aggregate: Aggregate; readonly collection: string; readonly field: string };

const PLAIN = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;
const AGGREGATE = /^(count|sum|avg|min|max)\(([A-Za-z_]\w*)\.([A-Za-z_]\w*)\)$/;
const SYSTEM = new Set(['id', 'created', 'updated']);

function parseSelect(text: string): Select | undefined {
  const a = AGGREGATE.exec(text);
  if (a) return { aggregate: a[1] as Aggregate, collection: a[2] ?? '', field: a[3] ?? '' };
  const p = PLAIN.exec(text);
  return p ? { collection: p[1] ?? '', field: p[2] ?? '' } : undefined;
}

/** The collections a view reads. */
export const viewSources = (def: ViewDef): string[] => [
  def.from,
  ...def.join.map((j) => j.collection),
];

/** Problems with a view's pipeline against the schemas, by schema path. */
export function checkView(
  schema: CollectionSchema,
  schemas: ReadonlyMap<string, CollectionSchema>,
): Record<string, string> {
  const def = schema.view;
  if (!def) return {};
  const problems: Record<string, string> = {};
  const has = (collection: string, field: string): boolean => {
    const s = schemas.get(collection);
    return s !== undefined && (SYSTEM.has(field) || storedFields(s).some((f) => f.name === field));
  };
  const sources = new Set(viewSources(def));
  if (sources.has(schema.name)) problems['view'] = 'a view cannot read itself';
  for (const name of sources) {
    if (!schemas.has(name)) problems['view'] = `no collection ${name}`;
    else if (schemas.get(name)?.type === 'view')
      problems['view'] = 'a view cannot read another view';
  }
  def.join.forEach((j, i) => {
    if (!has(j.collection, j.on.field) || !has(def.from, j.on.equals))
      problems[`view.join.${String(i)}.on`] = 'unknown field';
  });
  for (const g of def.group) {
    const [c = '', f = ''] = g.split('.');
    if (!sources.has(c) || !has(c, f)) problems['view.group'] = `unknown field ${g}`;
  }
  for (const [out, text] of Object.entries(def.select)) {
    const s = parseSelect(text);
    if (!s || !sources.has(s.collection) || !has(s.collection, s.field)) {
      problems[`view.select.${out}`] = `invalid expression ${text}`;
    } else if (!('aggregate' in s) && def.group.length > 0 && !def.group.includes(text)) {
      problems[`view.select.${out}`] = 'must be aggregated or grouped';
    }
    if (!schema.fields.some((f) => f.name === out))
      problems[`view.select.${out}`] = 'is not a field of the view';
  }
  return problems;
}

const idOf = (key: unknown): string =>
  createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 15);
const empty = (v: unknown): boolean => v === undefined || v === null || v === '';
type Row = Readonly<Record<string, RecordData | undefined>>;

function aggregate(kind: Aggregate, values: unknown[]): unknown {
  const present = values.filter((v) => !empty(v));
  if (kind === 'count') return present.length;
  const numbers = present.filter((v): v is number => typeof v === 'number');
  const sum = numbers.reduce((a, b) => a + b, 0);
  if (kind === 'sum') return sum;
  if (kind === 'avg') return numbers.length === 0 ? 0 : sum / numbers.length;
  const op = kind === 'min' ? '<' : '>';
  return (
    present.reduce<unknown>(
      (best, v) => (best === undefined || compareValues(op, v, best) ? v : best),
      undefined,
    ) ?? null
  );
}

/**
 * The view's rows by id: `from` joined and grouped, then selected. Ids hash
 * the group key (or the joined record ids), so a row keeps its id across runs.
 */
export function computeView(
  def: ViewDef,
  sources: ReadonlyMap<string, readonly RecordData[]>,
): Map<string, Record<string, unknown>> {
  let rows: Row[] = (sources.get(def.from) ?? []).map((r) => ({ [def.from]: r }));
  for (const j of def.join) {
    const byValue = new Map<string, RecordData[]>();
    for (const r of sources.get(j.collection) ?? []) {
      for (const v of [r[j.on.field]].flat()) {
        const list = byValue.get(String(v)) ?? [];
        list.push(r);
        byValue.set(String(v), list);
      }
    }
    rows = rows.flatMap((row) => {
      const key = row[def.from]?.[j.on.equals];
      const matches = empty(key) ? [] : (byValue.get(String(key)) ?? []);
      if (matches.length > 0) return matches.map((m) => ({ ...row, [j.collection]: m }));
      return j.type === 'left' ? [row] : [];
    });
  }
  const read = (row: Row, c: string, f: string): unknown => row[c]?.[f] ?? null;
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key =
      def.group.length > 0
        ? def.group.map((g) => {
            const [c = '', f = ''] = g.split('.');
            return read(row, c, f);
          })
        : viewSources(def).map((c) => row[c]?.['id'] ?? null);
    const id = idOf(key);
    const list = groups.get(id) ?? [];
    list.push(row);
    groups.set(id, list);
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const [id, members] of groups) {
    const fields: Record<string, unknown> = {};
    for (const [name, text] of Object.entries(def.select)) {
      const s = parseSelect(text);
      if (!s) continue;
      fields[name] =
        'aggregate' in s
          ? aggregate(
              s.aggregate,
              members.map((m) => read(m, s.collection, s.field)),
            )
          : members[0] && read(members[0], s.collection, s.field);
    }
    out.set(id, fields);
  }
  return out;
}
