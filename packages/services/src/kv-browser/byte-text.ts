import type { Encoding } from './schemas.js';

const strict = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** True when every byte string is valid UTF-8, so the whole value can travel as text. */
export function allUtf8(values: readonly Uint8Array[]): boolean {
  try {
    for (const v of values) strict.decode(v);
    return true;
  } catch {
    return false;
  }
}

export function toText(bytes: Uint8Array, encoding: Encoding): string {
  return encoding === 'utf8' ? strict.decode(bytes) : Buffer.from(bytes).toString('base64');
}

export function toBytes(text: string, encoding: Encoding): Uint8Array {
  return encoding === 'utf8' ? encoder.encode(text) : new Uint8Array(Buffer.from(text, 'base64'));
}
