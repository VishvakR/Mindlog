// The Porter (1980) suffix-stripping stemmer for English, applied to ASCII words.

function isConsonant(w: string, i: number): boolean {
  const c = w[i];
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
  if (c === 'y') return i === 0 || !isConsonant(w, i - 1);
  return true;
}

/** m in [C](VC){m}[V] for the first `end` letters. */
function measure(w: string, end: number): number {
  let m = 0;
  let i = 0;
  while (i < end && isConsonant(w, i)) i++;
  while (i < end) {
    while (i < end && !isConsonant(w, i)) i++;
    if (i >= end) break;
    while (i < end && isConsonant(w, i)) i++;
    m++;
  }
  return m;
}

function hasVowel(w: string, end: number): boolean {
  for (let i = 0; i < end; i++) if (!isConsonant(w, i)) return true;
  return false;
}

function doubleConsonant(w: string): boolean {
  const n = w.length;
  return n >= 2 && w[n - 1] === w[n - 2] && isConsonant(w, n - 1);
}

/** Ends consonant-vowel-consonant, the last not w, x or y (*o). */
function cvc(w: string, end: number): boolean {
  if (end < 3) return false;
  const last = w[end - 1];
  return (
    isConsonant(w, end - 1) &&
    !isConsonant(w, end - 2) &&
    isConsonant(w, end - 3) &&
    last !== 'w' &&
    last !== 'x' &&
    last !== 'y'
  );
}

/** Replaces `suffix` with `to` when the stem's measure exceeds `minMeasure`. */
function replace(w: string, suffix: string, to: string, minMeasure: number): string | undefined {
  if (!w.endsWith(suffix)) return undefined;
  const stem = w.length - suffix.length;
  return measure(w, stem) > minMeasure ? w.slice(0, stem) + to : w;
}

const STEP2: ReadonlyArray<readonly [string, string]> = [
  ['ational', 'ate'],
  ['tional', 'tion'],
  ['enci', 'ence'],
  ['anci', 'ance'],
  ['izer', 'ize'],
  ['abli', 'able'],
  ['alli', 'al'],
  ['entli', 'ent'],
  ['eli', 'e'],
  ['ousli', 'ous'],
  ['ization', 'ize'],
  ['ation', 'ate'],
  ['ator', 'ate'],
  ['alism', 'al'],
  ['iveness', 'ive'],
  ['fulness', 'ful'],
  ['ousness', 'ous'],
  ['aliti', 'al'],
  ['iviti', 'ive'],
  ['biliti', 'ble'],
];

const STEP3: ReadonlyArray<readonly [string, string]> = [
  ['icate', 'ic'],
  ['ative', ''],
  ['alize', 'al'],
  ['iciti', 'ic'],
  ['ical', 'ic'],
  ['ful', ''],
  ['ness', ''],
];

const STEP4 = [
  'al',
  'ance',
  'ence',
  'er',
  'ic',
  'able',
  'ible',
  'ant',
  'ement',
  'ment',
  'ent',
  'ion',
  'ou',
  'ism',
  'ate',
  'iti',
  'ous',
  'ive',
  'ize',
];

function step1(word: string): string {
  let w = word;
  if (w.endsWith('sses') || w.endsWith('ies')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);

  if (w.endsWith('eed')) {
    if (measure(w, w.length - 3) > 0) w = w.slice(0, -1);
  } else {
    const suffix = w.endsWith('ed') ? 'ed' : w.endsWith('ing') ? 'ing' : undefined;
    if (suffix && hasVowel(w, w.length - suffix.length)) {
      w = w.slice(0, -suffix.length);
      if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
      else if (doubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
      else if (measure(w, w.length) === 1 && cvc(w, w.length)) w += 'e';
    }
  }
  if (w.endsWith('y') && hasVowel(w, w.length - 1)) w = `${w.slice(0, -1)}i`;
  return w;
}

function step234(word: string): string {
  let w = word;
  for (const [suffix, to] of STEP2) {
    const r = w.endsWith(suffix) ? replace(w, suffix, to, 0) : undefined;
    if (r !== undefined) {
      w = r;
      break;
    }
  }
  for (const [suffix, to] of STEP3) {
    const r = w.endsWith(suffix) ? replace(w, suffix, to, 0) : undefined;
    if (r !== undefined) {
      w = r;
      break;
    }
  }
  // Longest matching suffix first ('ement' before 'ment' before 'ent').
  const suffix = STEP4.filter((s) => w.endsWith(s)).sort((a, b) => b.length - a.length)[0];
  if (suffix) {
    const stem = w.length - suffix.length;
    const ok = suffix !== 'ion' || /[st]$/.test(w.slice(0, stem));
    if (ok && measure(w, stem) > 1) w = w.slice(0, stem);
  }
  return w;
}

function step5(word: string): string {
  let w = word;
  if (w.endsWith('e')) {
    const m = measure(w, w.length - 1);
    if (m > 1 || (m === 1 && !cvc(w, w.length - 1))) w = w.slice(0, -1);
  }
  if (measure(w, w.length) > 1 && doubleConsonant(w) && w.endsWith('l')) w = w.slice(0, -1);
  return w;
}

/** The Porter stem of a lowercase word; non-ASCII and short words are returned as they are. */
export function stem(word: string): string {
  if (word.length <= 2 || !/^[a-z]+$/.test(word)) return word;
  return step5(step234(step1(word)));
}
