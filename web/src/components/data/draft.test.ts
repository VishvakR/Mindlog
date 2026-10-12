import { describe, expect, test } from 'vitest';
import type { KeyDetail } from '@/lib/api';
import { emptyDraft, fromDraft, toDraft } from './draft';

const base = { key: 'k', encoding: 'utf8' as const, ttlMs: null, length: 1, truncated: false };

describe('drafts', () => {
  test('round-trip every type', () => {
    const details: KeyDetail[] = [
      { ...base, type: 'string', value: 'hi' },
      { ...base, type: 'hash', value: [{ field: 'a', value: '1' }] },
      { ...base, type: 'list', value: ['x', 'y'] },
      { ...base, type: 'set', value: ['m'] },
      { ...base, type: 'zset', value: [{ member: 'm', score: 1.5 }] },
      { ...base, type: 'json', value: { a: [1, null] } },
    ];
    for (const d of details) {
      const { key: _k, encoding: _e, ttlMs: _t, length: _l, truncated: _r, ...value } = d;
      expect(fromDraft(toDraft(d))).toEqual(value);
    }
  });

  test('explain what to fix', () => {
    expect(fromDraft({ ...emptyDraft('zset'), rows: [['m', 'x']] })).toBe(
      'Row 1: the score must be a number.',
    );
    expect(fromDraft({ ...emptyDraft('json'), text: '{' })).toMatch(/^JSON is not valid/);
    expect(fromDraft({ ...emptyDraft('set'), rows: [] })).toBe('Add at least one element.');
  });
});
