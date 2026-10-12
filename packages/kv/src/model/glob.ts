const STAR = 0x2a;
const QUESTION = 0x3f;
const OPEN = 0x5b;
const CLOSE = 0x5d;
const CARET = 0x5e;
const DASH = 0x2d;
const BACKSLASH = 0x5c;

/** Matches one `[...]` class at `p` against byte `c`; returns [matched, index after the class]. */
function matchClass(pattern: Uint8Array, p: number, c: number): [boolean, number] {
  let i = p + 1;
  const negate = pattern[i] === CARET;
  if (negate) i++;
  let matched = false;
  for (;;) {
    const ch = pattern[i];
    if (ch === undefined) return [false, i];
    if (ch === BACKSLASH && i + 1 < pattern.length) {
      if (pattern[i + 1] === c) matched = true;
      i += 2;
    } else if (ch === CLOSE) {
      break;
    } else if (pattern[i + 1] === DASH && i + 2 < pattern.length && pattern[i + 2] !== CLOSE) {
      const a = ch;
      const b = pattern[i + 2] ?? a;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      if (c >= lo && c <= hi) matched = true;
      i += 3;
    } else {
      if (ch === c) matched = true;
      i++;
    }
  }
  return [negate ? !matched : matched, i + 1];
}

/**
 * Glob matching with Redis `stringmatchlen` semantics: `*`, `?`, `[abc]`,
 * `[^a]`, `[a-z]` (either order) and `\` escapes, over raw bytes.
 */
export function globMatch(pattern: Uint8Array, text: Uint8Array): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const ch = pattern[p];
    const c = text[t] as number;
    let advanced = false;
    if (ch === STAR) {
      while (pattern[p] === STAR) p++;
      if (p === pattern.length) return true;
      starP = p;
      starT = t;
      continue;
    }
    if (ch === QUESTION) {
      p++;
      t++;
      advanced = true;
    } else if (ch === OPEN) {
      const [matched, next] = matchClass(pattern, p, c);
      if (matched) {
        p = next;
        t++;
        advanced = true;
      }
    } else if (ch !== undefined) {
      const literal = ch === BACKSLASH && p + 1 < pattern.length ? pattern[p + 1] : ch;
      if (literal === c) {
        p += ch === BACKSLASH && p + 1 < pattern.length ? 2 : 1;
        t++;
        advanced = true;
      }
    }
    if (!advanced) {
      if (starP < 0) return false;
      p = starP;
      t = ++starT;
    }
  }
  while (pattern[p] === STAR) p++;
  return p === pattern.length;
}
