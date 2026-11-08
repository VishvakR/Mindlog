// Five-field cron expressions (minute hour day-of-month month day-of-week), in UTC (PLAN 16.8).

const RANGES: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

export interface Cron {
  readonly fields: readonly ReadonlySet<number>[];
  /** Whether day-of-month and day-of-week are both restricted (then either may match). */
  readonly eitherDay: boolean;
}

/** Parses `* , - /`; `undefined` when invalid. Day-of-week 7 means Sunday. */
export function parseCron(expr: string): Cron | undefined {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const fields: Set<number>[] = [];
  for (const [i, part] of parts.entries()) {
    const [lo = 0, hi = 0] = RANGES[i] ?? [];
    const set = new Set<number>();
    for (const item of part.split(',')) {
      const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) return undefined;
      const max = i === 4 ? 7 : hi;
      const from = m[1] ? lo : Number(m[2]);
      const to = m[1] ? hi : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from;
      const step = m[4] === undefined ? 1 : Number(m[4]);
      if (from < lo || to > max || from > to || step < 1) return undefined;
      for (let v = from; v <= to; v += step) set.add(i === 4 ? v % 7 : v);
    }
    fields.push(set);
  }
  return { fields, eitherDay: !parts[2]?.startsWith('*') && !parts[4]?.startsWith('*') };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.fields[2]?.has(d.getUTCDate()) === true;
  const dow = c.fields[4]?.has(d.getUTCDay()) === true;
  return c.eitherDay ? dom || dow : dom && dow;
}

const MINUTE = 60_000;
const SEARCH_YEARS = 5;

/** The first fire strictly after `afterMs`, or `undefined` if none within five years (`0 0 31 2 *`). */
export function nextFire(c: Cron, afterMs: number): number | undefined {
  let t = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
  const end = afterMs + SEARCH_YEARS * 366 * 86_400_000;
  while (t <= end) {
    const d = new Date(t);
    if (c.fields[3]?.has(d.getUTCMonth() + 1) !== true)
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    else if (!dayMatches(c, d))
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    else if (c.fields[1]?.has(d.getUTCHours()) !== true)
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
    else if (c.fields[0]?.has(d.getUTCMinutes()) !== true) t += MINUTE;
    else return t;
  }
  return undefined;
}
