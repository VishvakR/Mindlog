/** A key from a URL path: UTF-8 text, or base64 for binary keys. */
export const toBytes = (text: string, encoding: 'utf8' | 'base64'): Uint8Array =>
  encoding === 'utf8'
    ? new TextEncoder().encode(text)
    : new Uint8Array(Buffer.from(text, 'base64'));
