import type { KeyDetail, KeyType, KeyValue } from '@/lib/api';

/** What the editor holds: text for strings and JSON, rows of cells for collections. */
export type Draft = { type: KeyType; text: string; rows: string[][] };

const COLUMNS: Record<KeyType, number> = { string: 0, json: 0, hash: 2, list: 1, set: 1, zset: 2 };

export function emptyDraft(type: KeyType): Draft {
  return {
    type,
    text: type === 'json' ? '{\n  \n}' : '',
    rows: COLUMNS[type] ? [Array.from({ length: COLUMNS[type] }, () => '')] : [],
  };
}

export function toDraft(detail: KeyDetail): Draft {
  switch (detail.type) {
    case 'string':
      return { type: 'string', text: detail.value, rows: [] };
    case 'json':
      return { type: 'json', text: JSON.stringify(detail.value, null, 2), rows: [] };
    case 'hash':
      return { type: 'hash', text: '', rows: detail.value.map((e) => [e.field, e.value]) };
    case 'list':
    case 'set':
      return { type: detail.type, text: '', rows: detail.value.map((v) => [v]) };
    case 'zset':
      return { type: 'zset', text: '', rows: detail.value.map((e) => [e.member, String(e.score)]) };
  }
}

/** The value to save, or a message saying what to fix. */
export function fromDraft(d: Draft): KeyValue | string {
  switch (d.type) {
    case 'string':
      return { type: 'string', value: d.text };
    case 'json':
      try {
        return { type: 'json', value: JSON.parse(d.text) as unknown };
      } catch (e) {
        return `JSON is not valid: ${e instanceof Error ? e.message : String(e)}`;
      }
    case 'hash':
      return d.rows.length === 0
        ? 'Add at least one field.'
        : { type: 'hash', value: d.rows.map(([field = '', value = '']) => ({ field, value })) };
    case 'list':
    case 'set':
      return d.rows.length === 0
        ? 'Add at least one element.'
        : { type: d.type, value: d.rows.map(([v = '']) => v) };
    case 'zset': {
      if (d.rows.length === 0) return 'Add at least one member.';
      const bad = d.rows.findIndex(([, s = '']) => s.trim() === '' || !Number.isFinite(Number(s)));
      if (bad >= 0) return `Row ${String(bad + 1)}: the score must be a number.`;
      return {
        type: 'zset',
        value: d.rows.map(([member = '', s = '']) => ({ member, score: Number(s) })),
      };
    }
  }
}
