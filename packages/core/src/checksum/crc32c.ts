const POLY = 0x82f63b78; // CRC-32C (Castagnoli), reflected

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ POLY : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32C checksum (PLAN 7.3: every log entry is checksummed so corruption is
 * detected on read). Pass a previous result as `seed` to checksum in pieces.
 */
export function crc32c(data: Uint8Array, seed = 0): number {
  let crc = ~seed >>> 0;
  for (const byte of data) crc = ((TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  return ~crc >>> 0;
}
