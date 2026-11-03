/** Date macros (PocketBase `identifier_macros.go`), in UTC, as of `nowMs`. */
export const MACROS = [
  '@now',
  '@yesterday',
  '@tomorrow',
  '@second',
  '@minute',
  '@hour',
  '@day',
  '@month',
  '@weekday',
  '@year',
  '@todayStart',
  '@todayEnd',
  '@monthStart',
  '@monthEnd',
  '@yearStart',
  '@yearEnd',
] as const;

const DAY_MS = 86_400_000;

/** PocketBase's date text: `2006-01-02 15:04:05.000Z`. */
export function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ');
}

export function macroValue(name: string, nowMs: number): string | number | undefined {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  switch (name) {
    case '@now':
      return formatDate(nowMs);
    case '@yesterday':
      return formatDate(nowMs - DAY_MS);
    case '@tomorrow':
      return formatDate(nowMs + DAY_MS);
    case '@second':
      return d.getUTCSeconds();
    case '@minute':
      return d.getUTCMinutes();
    case '@hour':
      return d.getUTCHours();
    case '@day':
      return day;
    case '@month':
      return m + 1;
    case '@weekday':
      return d.getUTCDay();
    case '@year':
      return y;
    case '@todayStart':
      return formatDate(Date.UTC(y, m, day));
    case '@todayEnd':
      return formatDate(Date.UTC(y, m, day + 1) - 1);
    case '@monthStart':
      return formatDate(Date.UTC(y, m, 1));
    case '@monthEnd':
      return formatDate(Date.UTC(y, m + 1, 1) - 1);
    case '@yearStart':
      return formatDate(Date.UTC(y, 0, 1));
    case '@yearEnd':
      return formatDate(Date.UTC(y + 1, 0, 1) - 1);
    default:
      return undefined;
  }
}
