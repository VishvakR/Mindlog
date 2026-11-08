/** Collections API (PLAN 16) and the pure helpers of its dashboard page. */
import { request } from '@/lib/api';

export const FIELD_TYPES = [
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
  'vector',
  'memory',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type FieldDraft = Record<string, unknown> & {
  name: string;
  type: FieldType;
  required?: boolean;
};

export const RULE_SLOTS = [
  'listRule',
  'viewRule',
  'createRule',
  'updateRule',
  'deleteRule',
] as const;
export type RuleSlot = (typeof RULE_SLOTS)[number] | 'manageRule';

export interface IndexDraft {
  name: string;
  fields: string[];
  unique?: boolean;
}

export interface Schema {
  name: string;
  type: 'base' | 'auth' | 'view';
  fields: FieldDraft[];
  indexes: IndexDraft[];
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
  manageRule: string | null;
  view?: unknown;
  auth?: unknown;
}

export interface CollectionInfo {
  schema: Schema;
  version: string;
}

export interface RuleIssue {
  message: string;
  from: number;
  to: number;
}

export interface Completions {
  from: number;
  to: number;
  items: { label: string; detail: string }[];
}

export type RecordRow = Record<string, unknown> & { id: string };

export interface RecordPage {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: RecordRow[];
}

const headers = (tenant: string) => ({ 'x-mindlog-tenant': tenant });
const records = (name: string) => `/collections/${encodeURIComponent(name)}/records`;

export const collectionsApi = {
  list: (tenant: string) =>
    request<{ items: CollectionInfo[] }>('GET', '/collections', undefined, headers(tenant)),
  create: (tenant: string, schema: Partial<Schema>) =>
    request<CollectionInfo>('POST', '/collections', schema, headers(tenant)),
  save: (tenant: string, schema: Schema, version: string) =>
    request<CollectionInfo>(
      'PATCH',
      `/collections/${schema.name}`,
      { schema, version },
      headers(tenant),
    ),
  remove: (tenant: string, name: string) =>
    request<undefined>('DELETE', `/collections/${name}`, undefined, headers(tenant)),
  checkRule: (
    tenant: string,
    body: { collection: string; rule: string; cursor?: number; draft?: Schema },
  ) =>
    request<{ issues: RuleIssue[]; completions?: Completions }>(
      'POST',
      '/collections/rules/check',
      body,
      headers(tenant),
    ),
  records: (
    tenant: string,
    name: string,
    q: { page: number; perPage: number; filter: string; sort: string },
  ) => {
    const query = new URLSearchParams({ page: String(q.page), perPage: String(q.perPage) });
    if (q.filter) query.set('filter', q.filter);
    if (q.sort) query.set('sort', q.sort);
    return request<RecordPage>(
      'GET',
      `${records(name)}?${query.toString()}`,
      undefined,
      headers(tenant),
    );
  },
  createRecord: (tenant: string, name: string, body: Record<string, unknown>) =>
    request<RecordRow>('POST', records(name), body, headers(tenant)),
  updateRecord: (tenant: string, name: string, id: string, body: Record<string, unknown>) =>
    request<RecordRow>('PATCH', `${records(name)}/${id}`, body, headers(tenant)),
  deleteRecord: (tenant: string, name: string, id: string) =>
    request<undefined>('DELETE', `${records(name)}/${id}`, undefined, headers(tenant)),
};

/** The rule text and cursor after accepting a completion. */
export function applyCompletion(
  rule: string,
  completions: Pick<Completions, 'from' | 'to'>,
  label: string,
): { text: string; cursor: number } {
  const text = rule.slice(0, completions.from) + label + rule.slice(completions.to);
  return { text, cursor: completions.from + label.length };
}

/** Rule text split around the first issue, for the wavy underline; the issue is at least one character. */
export function issueSpans(text: string, issue: RuleIssue | undefined): [string, string, string] {
  if (!issue) return [text, '', ''];
  const from = Math.min(issue.from, text.length);
  const to = Math.min(Math.max(issue.to, from + 1), text.length);
  return [text.slice(0, from), text.slice(from, to), text.slice(to)];
}

/** Text fields of a form converted to the JSON value of their field type. */
export function fieldValue(type: FieldType, raw: string): unknown {
  if (type === 'number') return raw === '' ? 0 : Number(raw);
  if (type === 'json' || type === 'geoPoint')
    return raw === '' ? null : (JSON.parse(raw) as unknown);
  return raw;
}

/** A value as a table cell shows it. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'object'
    ? JSON.stringify(value)
    : String(value as string | number | boolean);
}
