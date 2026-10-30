import type { MemoryKind, SourceType, Trust } from '../types.js';

// Control characters other than tab, newline and carriage return.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const encoder = new TextEncoder();

/** Trims and strips control characters (PLAN 12.3 stage 1). */
export function normalizeText(text: string): string {
  return text.replace(CONTROL, '').trim();
}

export const byteLength = (text: string): number => encoder.encode(text).length;

const SENTENCE = /[^.!?\n]+[.!?]*\s*/g;
/** ~300 tokens per passage (PLAN 12.3 stage 3). */
const CHUNK_CHARS = 1200;
const OVERLAP = 0.15;

/** Sentence-aware passages of about 300 tokens with 15% overlap; short text stays whole. */
export function chunk(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const sentences = text.match(SENTENCE) ?? [text];
  const passages: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const s of sentences) {
    if (size + s.length > CHUNK_CHARS && current.length > 0) {
      passages.push(current.join('').trim());
      // Carry the last sentences (about 15%) into the next passage.
      const carried: string[] = [];
      let kept = 0;
      for (let i = current.length - 1; i >= 0 && kept < CHUNK_CHARS * OVERLAP; i--) {
        const sentence = current[i] ?? '';
        carried.unshift(sentence);
        kept += sentence.length;
      }
      current = carried;
      size = kept;
    }
    current.push(s);
    size += s.length;
  }
  if (current.length > 0) passages.push(current.join('').trim());
  return passages;
}

const STRONG =
  /\b(prefer|prefers|favou?rite|always|never|allergic|decided|decision|must|important|remember|my name|i am|i'm|hate|love)\b/i;
const FIRST_PERSON = /\b(i|my|me|we|our|mine)\b/i;

/** Heuristic importance 0..1 (PLAN 12.3 stage 8): preferences and decisions high, chit-chat low. */
export function importance(text: string, kind: MemoryKind): number {
  let score = 0.4;
  if (STRONG.test(text)) score += 0.3;
  if (FIRST_PERSON.test(text)) score += 0.1;
  if (kind === 'procedural') score += 0.1;
  if (text.length < 15) score -= 0.1;
  return Math.min(1, Math.max(0, Math.round(score * 100) / 100));
}

/** Source-based trust (PLAN 13.4): content from the web is quarantined until verified. */
/** The lower of two trust levels. */
export const minTrust = (a: Trust, b: Trust): Trust =>
  a === 'quarantined' || b === 'quarantined' ? 'quarantined' : a === 'normal' ? a : b;

/** Which tools and web domains are trusted (PLAN 13.4); everything else they bring is quarantined. */
export interface TrustPolicy {
  readonly trustedTools: readonly string[];
  readonly trustedDomains: readonly string[];
}

/** The host of a URL-like reference, lower-cased; '' when it has none. */
function hostOf(ref: string): string {
  try {
    return new URL(ref.includes('://') ? ref : `https://${ref}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const trustedHost = (host: string, domains: readonly string[]) =>
  host !== '' && domains.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * Trust by source (PLAN 13.4): tools off the allow-list, and web pages or
 * documents from untrusted domains, are quarantined; the rest is normal.
 */
export function trustOf(
  source: { readonly type: SourceType; readonly ref?: string | undefined },
  policy: TrustPolicy,
): Trust {
  const ref = source.ref ?? '';
  switch (source.type) {
    case 'tool':
      return policy.trustedTools.includes(ref) ? 'normal' : 'quarantined';
    case 'web':
    case 'document':
      return trustedHost(hostOf(ref), policy.trustedDomains) ? 'normal' : 'quarantined';
    default:
      return 'normal';
  }
}

/** Forgetting-curve stability S in days for a new memory: important ones decay slower. */
export const initialStrength = (importanceScore: number): number => 1 + 4 * importanceScore;

const PRONOUNS = new Set(
  'i me my mine we us our ours you your yours he him his she her hers it its they them their theirs this that'.split(
    ' ',
  ),
);

/** Whether a recognised span names something: not a pronoun, not a single character. */
export function usefulEntity(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.length > 1 && !PRONOUNS.has(t);
}
