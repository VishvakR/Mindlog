import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { FieldDef } from '@mindlog/collections';
import { fieldNormalize, fieldSchema, fieldValidate, sanitizeHtml } from '@mindlog/collections';

const field = (raw: Record<string, unknown>): FieldDef => fieldSchema.parse({ name: 'f', ...raw });
const check = (raw: Record<string, unknown>, value: unknown) => {
  const f = field(raw);
  return fieldValidate(f, fieldNormalize(f, value));
};

describe('field types', () => {
  test.each([
    [{ type: 'text', max: 3 }, 'abcd', 'at most 3 characters'],
    [{ type: 'text', pattern: '^[a-z]+$' }, 'A1', 'invalid format'],
    [{ type: 'text', required: true }, '', 'cannot be blank'],
    [{ type: 'number', onlyInt: true }, '1.5', 'must be an integer'],
    [{ type: 'number', min: 2 }, 1, 'must be at least 2'],
    [{ type: 'number' }, 'abc', 'must be a number'],
    [{ type: 'bool', required: true }, 'false', 'must be true'],
    [{ type: 'email' }, 'nope', 'invalid email address'],
    [{ type: 'email', onlyDomains: ['x.io'] }, 'a@y.io', 'email domain is not allowed'],
    [{ type: 'url' }, 'javascript:alert(1)', 'only http and https URLs'],
    [{ type: 'date' }, 'not a date', 'must be a date'],
    [{ type: 'select', values: ['a'] }, 'b', 'b is not an allowed value'],
    [{ type: 'select', values: ['a', 'b'], maxSelect: 1 }, ['a', 'b'], undefined],
    [
      { type: 'relation', collection: 'users', maxSelect: 2 },
      ['bad id'],
      'bad id is not a record id',
    ],
    [
      { type: 'relation', collection: 'users', maxSelect: 3, minSelect: 2 },
      ['aaaaaaaaaaaaaaa'],
      'at least 2 values',
    ],
    [{ type: 'file', maxSelect: 1 }, '../etc/passwd', '../etc/passwd is not a file name'],
    [{ type: 'json', maxSize: 5 }, '{"a":12345}', 'at most 5 bytes'],
    [{ type: 'geoPoint' }, { lon: 200, lat: 0 }, 'lon must be within ±180 and lat within ±90'],
    [{ type: 'vector', source: 'x', dimensions: 2 }, [1, 2, 3], 'must have 2 dimensions'],
    [{ type: 'memory' }, 'x', 'must be a memory id'],
  ])('%j with %j', (raw, value, expected) => {
    expect(check(raw, value)).toBe(expected);
  });

  test('normalization converts form text', () => {
    const n = (raw: Record<string, unknown>, v: unknown) => fieldNormalize(field(raw), v);
    expect(n({ type: 'number' }, '42')).toBe(42);
    expect(n({ type: 'bool' }, 'on')).toBe(true);
    expect(n({ type: 'date' }, '2026-01-02')).toBe('2026-01-02 00:00:00.000Z');
    expect(n({ type: 'select', values: ['a', 'b'], maxSelect: 1 }, ['a', 'b'])).toBe('b');
    expect(n({ type: 'select', values: ['a', 'b'], maxSelect: 2 }, 'a')).toEqual(['a']);
    expect(n({ type: 'email' }, ' A@B.io ')).toBe('a@b.io');
    expect(n({ type: 'json' }, '{"a":1}')).toEqual({ a: 1 });
    expect(n({ type: 'geoPoint' }, '{"lon":1,"lat":2}')).toEqual({ lon: 1, lat: 2 });
  });
});

describe('editor sanitizer', () => {
  test.each([
    ['<p onclick="x()">hi</p>', '<p>hi</p>'],
    ['<script>alert(1)</script>ok', 'ok'],
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="java\tscript:alert(1)">x</a>', '<a>x</a>'],
    [
      '<a href="https://x.io" target="_blank">x</a>',
      '<a href="https://x.io" target="_blank" rel="noopener noreferrer">x</a>',
    ],
    [
      '<img src="data:image/png;base64,AAAA" onerror="x">',
      '<img src="data:image/png;base64,AAAA">',
    ],
    // A quoted < ends the tag early: the rest is escaped text around a real <b>.
    ['<img src="data:text/html,<b>">', '&lt;img src="data:text/html,<b>"&gt;'],
    ['a < b > c <!-- hidden -->', 'a &lt; b &gt; c '],
    ['<scr<script></script>ipt>alert(1)</script>', 'alert(1)'],
    ['<IFRAME src=x></IFRAME><b>bold</b>', '<b>bold</b>'],
  ])('%s', (input, output) => {
    expect(sanitizeHtml(input)).toBe(output);
  });

  test('sanitizing is idempotent, so apply can check it', () => {
    const unit = fc.constantFrom(
      ...'<>/="\' abp&;:-'.split(''),
      '<a href="',
      '<script>',
      '</script>',
      'javascript:',
      '<img src=',
      '<!--',
      '-->',
      'onclick=',
    );
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit, maxLength: 30 })), (html) => {
        const once = sanitizeHtml(html);
        expect(sanitizeHtml(once)).toBe(once);
        for (const tag of once.toLowerCase().match(/<[^>]*>/g) ?? []) {
          expect(tag).not.toMatch(/^<script|javascript:|\son[a-z]+=/);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
