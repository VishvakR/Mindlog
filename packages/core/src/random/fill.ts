/** Fills bytes four at a time from a 32-bit source. */
export function fillFromUint32(target: Uint8Array, nextUint32: () => number): void {
  let i = 0;
  for (; i + 4 <= target.length; i += 4) {
    const v = nextUint32();
    target[i] = v >>> 24;
    target[i + 1] = (v >>> 16) & 0xff;
    target[i + 2] = (v >>> 8) & 0xff;
    target[i + 3] = v & 0xff;
  }
  if (i < target.length) {
    let v = nextUint32();
    for (; i < target.length; i++) {
      target[i] = v & 0xff;
      v >>>= 8;
    }
  }
}

/** Combines two 32-bit draws into a float in [0, 1) with 53 random bits. */
export function toUnitFloat(hi: number, lo: number): number {
  return ((hi >>> 5) * 67_108_864 + (lo >>> 6)) / 9_007_199_254_740_992;
}
