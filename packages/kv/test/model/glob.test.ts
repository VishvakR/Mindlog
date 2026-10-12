import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { decodeCursor, encodeCursor, globMatch } from '@mindlog/kv';

const b = (s: string) => new TextEncoder().encode(s);
const m = (pattern: string, text: string) => globMatch(b(pattern), b(text));

describe('globMatch (Redis stringmatchlen)', () => {
  test.each([
    ['*', '', true],
    ['*', 'anything', true],
    ['h?llo', 'hello', true],
    ['h?llo', 'hllo', false],
    ['h*llo', 'heeeello', true],
    ['h[ae]llo', 'hallo', true],
    ['h[ae]llo', 'hillo', false],
    ['h[^e]llo', 'hallo', true],
    ['h[^e]llo', 'hello', false],
    ['h[a-b]llo', 'hbllo', true],
    ['h[b-a]llo', 'hallo', true],
    ['h\\*llo', 'h*llo', true],
    ['h\\*llo', 'hello', false],
    ['user:*:name', 'user:42:name', true],
    ['user:*:name', 'user:42:age', false],
    ['*a*b*', 'xxaxxbxx', true],
    ['*a*b*', 'xxbxxaxx', false],
    ['[abc', 'a', false],
  ])('%s against %j is %s', (pattern, text, expected) => {
    expect(m(pattern, text)).toBe(expected);
  });

  test('a literal pattern matches only itself; * matches everything', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9:]*$/), fc.stringMatching(/^[a-z0-9:]*$/), (a, c) => {
        expect(m(a, c)).toBe(a === c);
        expect(m('*', c)).toBe(true);
        expect(m(`${a}*`, a + c)).toBe(true);
      }),
    );
  });
});

describe('SCAN cursors', () => {
  test('round-trip any key name and stay numeric', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), (name) => {
        const cursor = encodeCursor(name);
        expect(cursor).toMatch(/^[1-9][0-9]*$/);
        expect(decodeCursor(b(cursor))).toEqual(name);
      }),
    );
  });

  test('0 starts; garbage is invalid', () => {
    expect(decodeCursor(b('0'))).toBeNull();
    expect(decodeCursor(b('abc'))).toBeUndefined();
    expect(decodeCursor(b('2'))).toBeUndefined();
  });
});
