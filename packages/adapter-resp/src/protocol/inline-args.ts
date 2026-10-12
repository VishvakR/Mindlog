const ESCAPES: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, a: 0x07 };
const isSpace = (c: number | undefined) =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;
const hexValue = (c: number | undefined): number => {
  if (c === undefined) return -1;
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
};

/** Splits an inline request like Valkey `sdssplitargs`: spaces, "quotes" with escapes, 'quotes'. */
export function splitInline(line: Uint8Array): Uint8Array[] | undefined {
  const args: Uint8Array[] = [];
  let i = 0;
  while (i < line.length) {
    while (isSpace(line[i])) i++;
    if (i >= line.length) break;
    const out: number[] = [];
    let quote: 0x22 | 0x27 | undefined;
    for (;;) {
      const c = line[i];
      if (quote === 0x22) {
        if (c === undefined) return undefined;
        if (
          c === 0x5c &&
          line[i + 1] === 0x78 &&
          hexValue(line[i + 2]) >= 0 &&
          hexValue(line[i + 3]) >= 0
        ) {
          out.push(hexValue(line[i + 2]) * 16 + hexValue(line[i + 3]));
          i += 4;
        } else if (c === 0x5c && line[i + 1] !== undefined) {
          const next = line[i + 1] as number;
          out.push(ESCAPES[String.fromCharCode(next)] ?? next);
          i += 2;
        } else if (c === 0x22) {
          if (line[i + 1] !== undefined && !isSpace(line[i + 1])) return undefined;
          i++;
          break;
        } else {
          out.push(c);
          i++;
        }
      } else if (quote === 0x27) {
        if (c === undefined) return undefined;
        if (c === 0x5c && line[i + 1] === 0x27) {
          out.push(0x27);
          i += 2;
        } else if (c === 0x27) {
          if (line[i + 1] !== undefined && !isSpace(line[i + 1])) return undefined;
          i++;
          break;
        } else {
          out.push(c);
          i++;
        }
      } else if (c === undefined || isSpace(c)) {
        break;
      } else if (c === 0x22 || c === 0x27) {
        quote = c;
        i++;
      } else {
        out.push(c);
        i++;
      }
    }
    args.push(Uint8Array.from(out));
  }
  return args;
}
