import { describe, expect, test } from 'vitest';
import { applyCompletion, cellText, fieldValue, issueSpans } from '@/lib/collections';

describe('collections helpers', () => {
  test('a completion replaces the partial word and puts the cursor after it', () => {
    expect(applyCompletion('user.na = 1', { from: 5, to: 7 }, 'name')).toEqual({
      text: 'user.name = 1',
      cursor: 9,
    });
  });

  test('issue spans always cover something and stay inside the text', () => {
    expect(issueSpans('abc', undefined)).toEqual(['abc', '', '']);
    expect(issueSpans('a = ', { message: '', from: 1, to: 1 })).toEqual(['a', ' ', '= ']);
    expect(issueSpans('ab', { message: '', from: 9, to: 12 })).toEqual(['ab', '', '']);
  });

  test('form text becomes typed values', () => {
    expect(fieldValue('number', '4.5')).toBe(4.5);
    expect(fieldValue('json', '{"a":1}')).toEqual({ a: 1 });
    expect(fieldValue('text', '5')).toBe('5');
    expect(cellText(null)).toBe('—');
    expect(cellText(['a'])).toBe('["a"]');
  });
});
