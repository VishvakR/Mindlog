/** Rule functions (PocketBase `token_functions.go`): name → allowed argument counts. */
export const FUNCTIONS: Readonly<Record<string, { readonly min: number; readonly max: number }>> = {
  geoDistance: { min: 4, max: 4 },
  strftime: { min: 2, max: 10 },
};

const EARTH_KM = 6371;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in km between two (lon, lat) points (haversine). */
export function geoDistance(lonA: number, latA: number, lonB: number, latB: number): number {
  const dLat = rad(latB - latA);
  const dLon = rad(lonB - lonA);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(latA)) * Math.cos(rad(latB)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const UNITS: Readonly<Record<string, number>> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** Applies one SQLite-style modifier; `undefined` for an unsupported one. */
function modify(ms: number, modifier: string): number | undefined {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (modifier.trim().toLowerCase()) {
    case 'start of day':
      return Date.UTC(y, m, d.getUTCDate());
    case 'start of month':
      return Date.UTC(y, m, 1);
    case 'start of year':
      return Date.UTC(y, 0, 1);
    case 'utc':
      return ms;
  }
  const shift = /^([+-]?\d+(?:\.\d+)?)\s+(second|minute|hour|day|month|year)s?$/.exec(
    modifier.trim().toLowerCase(),
  );
  if (shift === null) return undefined;
  const amount = Number(shift[1]);
  const unit = shift[2] ?? '';
  if (unit === 'month' || unit === 'year') {
    const months = unit === 'year' ? amount * 12 : amount;
    const next = new Date(ms);
    next.setUTCMonth(next.getUTCMonth() + months);
    return next.getTime();
  }
  return ms + amount * (UNITS[unit] ?? 0);
}

/** Reads a date text (`2006-01-02 15:04:05.000Z`, ISO) or unix seconds; `undefined` if invalid. */
export function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value * 1000 : undefined;
  if (typeof value !== 'string' || value === '') return undefined;
  const ms = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(ms) ? undefined : ms;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** SQLite `strftime`: `%d %f %H %j %m %M %s %S %w %Y %%`; `null` for an invalid time or modifier. */
export function strftime(
  format: string,
  time: unknown,
  modifiers: readonly string[],
): string | null {
  let ms = parseTime(time);
  for (const modifier of modifiers) {
    if (ms === undefined) return null;
    ms = modify(ms, modifier);
  }
  if (ms === undefined) return null;
  const d = new Date(ms);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const fields: Readonly<Record<string, string>> = {
    d: pad(d.getUTCDate()),
    f: `${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`,
    H: pad(d.getUTCHours()),
    j: pad(Math.floor((ms - yearStart) / 86_400_000) + 1, 3),
    m: pad(d.getUTCMonth() + 1),
    M: pad(d.getUTCMinutes()),
    s: String(Math.floor(ms / 1000)),
    S: pad(d.getUTCSeconds()),
    w: String(d.getUTCDay()),
    Y: pad(d.getUTCFullYear(), 4),
    '%': '%',
  };
  return format.replace(/%(.)/g, (whole, c: string) => fields[c] ?? whole);
}

/** Whether a modifier text is supported, for the checker. */
export function isModifier(modifier: string): boolean {
  return modify(0, modifier) !== undefined;
}
