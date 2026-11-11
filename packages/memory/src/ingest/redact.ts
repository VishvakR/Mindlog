/** What the redaction stage can mask (PLAN 12.3 stage 2). */
export const REDACTION_KINDS = ['email', 'phone', 'id', 'card'] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** US SSNs and IBANs: the ID shapes with a fixed layout. */
const ID = /\b(?:\d{3}-\d{2}-\d{4}|[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)\b/g;
/** A run of digits with spaces, dots, dashes or brackets; cards and phones are told apart by digit count and Luhn. */
const DIGIT_RUN = /\+?\(?\d[\d\s().-]{7,}\d/g;

const digitsOf = (s: string): string => s.replace(/\D/g, '');

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function maskRun(run: string, kinds: ReadonlySet<RedactionKind>): string {
  const digits = digitsOf(run);
  if (kinds.has('card') && digits.length >= 13 && digits.length <= 19 && luhn(digits))
    return '[CARD]';
  // Phones have 9–15 digits (E.164); a bare number such as an amount or a year has no separators.
  const separated = /[\s().+-]/.test(run);
  if (kinds.has('phone') && separated && digits.length >= 9 && digits.length <= 15)
    return '[PHONE]';
  return run;
}

/**
 * Masks personal data in text (PLAN 12.3 stage 2, 18.1): local patterns only,
 * no model, so it runs on every path including degraded and async ones. The
 * placeholders hold no digits or `@`, so redacting twice changes nothing.
 */
export function redact(text: string, kinds: readonly RedactionKind[]): string {
  if (kinds.length === 0) return text;
  const on = new Set(kinds);
  let out = text;
  if (on.has('email')) out = out.replace(EMAIL, '[EMAIL]');
  if (on.has('id')) out = out.replace(ID, '[ID]');
  if (on.has('card') || on.has('phone')) out = out.replace(DIGIT_RUN, (run) => maskRun(run, on));
  return out;
}

/** Redacts every string inside JSON-shaped metadata, keys included. */
export function redactValue(value: unknown, kinds: readonly RedactionKind[]): unknown {
  if (typeof value === 'string') return redact(value, kinds);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, kinds));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [redact(k, kinds), redactValue(v, kinds)]),
    );
  return value;
}
