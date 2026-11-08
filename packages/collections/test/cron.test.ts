import fc from 'fast-check';
import { expect, test } from 'vitest';
import { nextFire, parseCron } from '@mindlog/collections';

const fire = (expr: string, after: string) => {
  const c = parseCron(expr);
  if (!c) throw new Error(expr);
  const t = nextFire(c, Date.parse(after));
  return t === undefined ? undefined : new Date(t).toISOString();
};

test.each([
  ['* * * * *', '2026-01-01T00:00:30Z', '2026-01-01T00:01:00.000Z'],
  ['*/15 * * * *', '2026-01-01T00:16:00Z', '2026-01-01T00:30:00.000Z'],
  ['0 3 * * *', '2026-01-01T03:00:00Z', '2026-01-02T03:00:00.000Z'],
  ['0 0 1 * *', '2026-01-31T12:00:00Z', '2026-02-01T00:00:00.000Z'],
  ['0 9 * * 1-5', '2026-01-02T10:00:00Z', '2026-01-05T09:00:00.000Z'],
  ['0 0 13 * 5', '2026-01-02T01:00:00Z', '2026-01-09T00:00:00.000Z'],
  ['0 0 29 2 *', '2026-01-01T00:00:00Z', '2028-02-29T00:00:00.000Z'],
  ['0 0 * * 7', '2026-01-01T00:00:00Z', '2026-01-04T00:00:00.000Z'],
])('%s after %s', (expr, after, next) => {
  expect(fire(expr, after)).toBe(next);
});

test('impossible dates and invalid expressions', () => {
  expect(fire('0 0 31 2 *', '2026-01-01T00:00:00Z')).toBeUndefined();
  for (const bad of [
    '',
    '* * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '5-1 * * * *',
    '*/0 * * * *',
    'a * * * *',
  ]) {
    expect(parseCron(bad)).toBeUndefined();
  }
});

test('the next fire matches, and no earlier minute does', () => {
  const part = (max: number) =>
    fc.oneof(
      fc.constant('*'),
      fc.integer({ min: 0, max }).map(String),
      fc.integer({ min: 1, max: 9 }).map((n) => `*/${String(n)}`),
    );
  fc.assert(
    fc.property(part(59), part(23), fc.integer({ min: 0, max: 400 * 1440 }), (m, h, offset) => {
      const c = parseCron(`${m} ${h} * * *`);
      if (!c) return;
      const after = Date.UTC(2026, 0, 1) + offset * 60_000 + 7;
      const next = nextFire(c, after) ?? 0;
      expect(next).toBeGreaterThan(after);
      const d = new Date(next);
      expect(c.fields[0]?.has(d.getUTCMinutes()) && c.fields[1]?.has(d.getUTCHours())).toBe(true);
      for (let t = Math.floor(after / 60_000) * 60_000 + 60_000; t < next; t += 60_000) {
        const e = new Date(t);
        expect(c.fields[0]?.has(e.getUTCMinutes()) && c.fields[1]?.has(e.getUTCHours())).toBe(
          false,
        );
      }
    }),
    { numRuns: 200 },
  );
});
