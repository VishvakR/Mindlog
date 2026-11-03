import { formatDate, parseTime } from '@mindlog/rules';
import type { FieldSpec } from './field-spec.js';
import { isString } from './field-spec.js';
import { sanitizeHtml } from './sanitize-html.js';

const toText = (v: unknown): string | undefined =>
  isString(v)
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : v == null
        ? ''
        : undefined;

const blank = (required: boolean, v: string): string | undefined =>
  required && v === '' ? 'cannot be blank' : undefined;

export const textField: FieldSpec<'text'> = {
  type: 'text',
  zero: () => '',
  normalize: (_f, v) => toText(v),
  validate(f, v) {
    if (!isString(v)) return 'must be text';
    const chars = Array.from(v).length;
    if (f.min > 0 && chars < f.min && v !== '') return `at least ${String(f.min)} characters`;
    if (f.max > 0 && chars > f.max) return `at most ${String(f.max)} characters`;
    if (f.pattern !== '' && v !== '' && !new RegExp(f.pattern).test(v)) return 'invalid format';
    return blank(f.required, v);
  },
};

// Deliberately simple: one @, a dot in the domain, no spaces.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailField: FieldSpec<'email'> = {
  type: 'email',
  zero: () => '',
  normalize: (_f, v) => (isString(v) ? v.trim().toLowerCase() : v == null ? '' : undefined),
  validate(f, v) {
    if (!isString(v)) return 'must be text';
    if (v !== '' && (!EMAIL.test(v) || v.length > 254)) return 'invalid email address';
    if (v !== '' && f.onlyDomains.length > 0 && !f.onlyDomains.includes(v.split('@')[1] ?? '')) {
      return 'email domain is not allowed';
    }
    return blank(f.required, v);
  },
};

export const urlField: FieldSpec<'url'> = {
  type: 'url',
  zero: () => '',
  normalize: (_f, v) => (isString(v) ? v.trim() : v == null ? '' : undefined),
  validate(f, v) {
    if (!isString(v)) return 'must be text';
    if (v !== '') {
      if (!URL.canParse(v)) return 'invalid URL';
      if (!['http:', 'https:'].includes(new URL(v).protocol)) return 'only http and https URLs';
    }
    return blank(f.required, v);
  },
};

export const editorField: FieldSpec<'editor'> = {
  type: 'editor',
  zero: () => '',
  normalize: (_f, v) => {
    const text = toText(v);
    return text === undefined ? undefined : sanitizeHtml(text);
  },
  validate(f, v) {
    if (!isString(v)) return 'must be text';
    if (sanitizeHtml(v) !== v) return 'contains disallowed HTML';
    if (f.maxSize > 0 && Buffer.byteLength(v) > f.maxSize)
      return `at most ${String(f.maxSize)} bytes`;
    return blank(f.required, v);
  },
};

const DATE_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Dates are stored as PocketBase's `2006-01-02 15:04:05.000Z`, so text order is time order. */
export function normalizeDate(v: unknown): string | undefined {
  if (v === '' || v == null) return '';
  const ms = typeof v === 'number' ? v : parseTime(v);
  return ms === undefined || !Number.isFinite(ms) ? undefined : formatDate(ms);
}

const validateDate = (required: boolean, v: unknown): string | undefined => {
  if (!isString(v) || (v !== '' && !DATE_TEXT.test(v))) return 'must be a date';
  return blank(required, v);
};

export const dateField: FieldSpec<'date'> = {
  type: 'date',
  zero: () => '',
  normalize: (_f, v) => normalizeDate(v),
  validate: (f, v) => validateDate(f.required, v),
};

export const autodateField: FieldSpec<'autodate'> = {
  type: 'autodate',
  zero: () => '',
  normalize: (_f, v) => normalizeDate(v),
  validate: (_f, v) => validateDate(false, v),
};

const MEMORY_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const memoryField: FieldSpec<'memory'> = {
  type: 'memory',
  zero: () => '',
  normalize: (_f, v) => (isString(v) ? v.trim() : v == null ? '' : undefined),
  validate(f, v) {
    if (!isString(v) || (v !== '' && !MEMORY_ID.test(v))) return 'must be a memory id';
    return blank(f.required, v);
  },
};

/** Argon2id PHC strings, computed on the leader (ADR-0035). */
export const passwordField: FieldSpec<'password'> = {
  type: 'password',
  zero: () => '',
  normalize: (_f, v) => (isString(v) ? v : undefined),
  validate: (f, v) =>
    !isString(v) || (v !== '' && !v.startsWith('$argon2id$'))
      ? 'must be a password hash'
      : blank(f.required, v),
};
