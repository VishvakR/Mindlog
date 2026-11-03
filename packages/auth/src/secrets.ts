import { createHash, randomBytes, randomInt } from 'node:crypto';

/** sha256 hex, for refresh tokens and OTP codes stored at rest. */
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A random URL-safe secret of `bytes` random bytes. */
export const randomSecret = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** A numeric one-time code of `length` digits. */
export function otpCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++) code += String(randomInt(10));
  return code;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A PocketBase-style record id: 15 characters of [a-z0-9]. */
export function recordId(): string {
  let id = '';
  for (let i = 0; i < 15; i++) id += ID_ALPHABET.charAt(randomInt(ID_ALPHABET.length));
  return id;
}
