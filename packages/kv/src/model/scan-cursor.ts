/**
 * Stateless SCAN cursors: the decimal form of `0x01 · lastKeyName`, so they
 * stay numeric (clients such as redis-py parse cursors as integers) and need
 * no server-side state. "0" starts and ends an iteration.
 */
export function encodeCursor(lastName: Uint8Array): string {
  return BigInt(`0x01${Buffer.from(lastName).toString('hex')}`).toString(10);
}

/** The key name to resume after, `null` for "0", or `undefined` if invalid. */
export function decodeCursor(raw: Uint8Array): Uint8Array | null | undefined {
  const text = new TextDecoder().decode(raw);
  if (!/^[0-9]+$/.test(text)) return undefined;
  if (/^0+$/.test(text)) return null;
  const raw16 = BigInt(text).toString(16);
  const hex = raw16.length % 2 === 0 ? raw16 : `0${raw16}`;
  if (!hex.startsWith('01')) return undefined;
  return Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
}
