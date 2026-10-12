import { describe, expect, test } from 'vitest';
import { splitInline } from '@mindlog/adapter-resp';

const split = (line: string) =>
  splitInline(Buffer.from(line, 'latin1'))?.map((a) => Buffer.from(a).toString('latin1'));

describe('splitInline (Valkey sdssplitargs)', () => {
  test('splits on runs of whitespace', () => {
    expect(split('  SET  k\tv ')).toEqual(['SET', 'k', 'v']);
    expect(split('')).toEqual([]);
    expect(split('   ')).toEqual([]);
  });

  test('double quotes support escapes and hex bytes', () => {
    expect(split('SET k "a b\\n\\x41\\"\\\\"')).toEqual(['SET', 'k', 'a b\nA"\\']);
    expect(split('"\\xzz"')).toEqual(['xzz']);
    expect(split('""')).toEqual(['']);
  });

  test("single quotes only unescape \\'", () => {
    expect(split("'it\\'s \\n'")).toEqual(["it's \\n"]);
  });

  test('unbalanced quotes or a quote followed by text are rejected', () => {
    expect(split('"open')).toBeUndefined();
    expect(split("'open")).toBeUndefined();
    expect(split('"a"b')).toBeUndefined();
    expect(split("'a'b")).toBeUndefined();
  });

  test('a quote in the middle of an argument starts a quoted part', () => {
    expect(split('ab"c d"')).toEqual(['abc d']);
  });
});
