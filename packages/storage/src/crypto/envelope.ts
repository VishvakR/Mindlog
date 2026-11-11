import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** First byte of every encrypted value; anything else in an encrypted store is corruption. */
export const ENVELOPE_V1 = 0xe1;
const NONCE = 12;
const TAG = 16;

/** `0xE1 · keyId(u32 BE) · nonce(12) · ciphertext · tag(16)`; AES-256-GCM with `aad` bound in. */
export function seal(
  keyId: number,
  key: Uint8Array,
  aad: Uint8Array,
  plain: Uint8Array,
): Uint8Array {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const out = Buffer.allocUnsafe(1 + 4 + NONCE + body.length + TAG);
  out[0] = ENVELOPE_V1;
  out.writeUInt32BE(keyId, 1);
  nonce.copy(out, 5);
  body.copy(out, 5 + NONCE);
  cipher.getAuthTag().copy(out, 5 + NONCE + body.length);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/** The key id an envelope was sealed with; throws when the bytes are not an envelope. */
export function envelopeKeyId(sealed: Uint8Array): number {
  if (sealed.length < 1 + 4 + NONCE + TAG || sealed[0] !== ENVELOPE_V1)
    throw new Error('stored value is not encrypted: corrupt or foreign data');
  return Buffer.from(sealed.buffer, sealed.byteOffset, sealed.length).readUInt32BE(1);
}

/** Opens an envelope; a wrong key, a wrong `aad` or tampering throws. */
export function unseal(key: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array {
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.length);
  const nonce = bytes.subarray(5, 5 + NONCE);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG));
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(5 + NONCE, bytes.length - TAG)),
    decipher.final(),
  ]);
  return new Uint8Array(plain.buffer, plain.byteOffset, plain.length);
}
