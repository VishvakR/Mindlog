/** The form prompts are compared and stored in: NFKC, lowercase, single spaces. */
export const normalizePrompt = (prompt: string): string =>
  prompt.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function encodeVector(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length * 4);
  const view = new DataView(out.buffer);
  v.forEach((x, i) => {
    view.setFloat32(i * 4, x, true);
  });
  return out;
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: bytes.byteLength / 4 }, (_, i) =>
    view.getFloat32(i * 4, true),
  );
}

/** Dot product; the cosine of two L2-normalised vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}
