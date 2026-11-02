import { gunzipSync, gzipSync } from 'node:zlib';

// A minimal ustar reader and writer for memory cubes and COGX archives (PLAN 13.11).
// shortcut: regular files only, names up to 100 bytes; fine for the fixed member names both formats use.

export interface TarFile {
  readonly name: string;
  readonly data: Uint8Array;
}

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function header(name: string, size: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (at: number, s: string) => {
    h.set(encoder.encode(s), at);
  };
  put(0, name);
  put(100, '0000644\0');
  put(108, '0000000\0');
  put(116, '0000000\0');
  put(124, `${size.toString(8).padStart(11, '0')}\0`);
  put(136, '00000000000\0'); // mtime 0: equal contents give equal archives
  put(148, '        ');
  h[156] = 0x30; // '0': regular file
  put(257, 'ustar\0');
  put(263, '00');
  const sum = h.reduce((a, b) => a + b, 0);
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

/** A gzip-compressed tar of the files, in the order given. */
export function packTar(files: readonly TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of files) {
    if (encoder.encode(f.name).length > 99) throw new RangeError(`tar name too long: ${f.name}`);
    parts.push(header(f.name, f.data.length), f.data);
    const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(2 * BLOCK));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

export interface UnpackLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

const field = (h: Uint8Array, at: number, len: number) =>
  decoder
    .decode(h.subarray(at, at + len))
    .replace(/\0.*$/s, '')
    .trim();

/**
 * The regular files of a gzip (or plain) tar. Absolute names, `..` segments
 * and archives over the limits are refused; other entry types are skipped.
 */
export function unpackTar(bytes: Uint8Array, limits: UnpackLimits): TarFile[] {
  const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const raw = gz ? new Uint8Array(gunzipSync(bytes, { maxOutputLength: limits.maxBytes })) : bytes;
  const files: TarFile[] = [];
  let at = 0;
  while (at + BLOCK <= raw.length) {
    const h = raw.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    const prefix = field(h, 345, 155);
    const name = (prefix ? `${prefix}/` : '') + field(h, 0, 100);
    const size = parseInt(field(h, 124, 12) || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new RangeError('bad tar header');
    const type = String.fromCharCode(h[156] ?? 0);
    at += BLOCK;
    if (at + size > raw.length) throw new RangeError('truncated tar');
    if (type === '0' || type === '\0') {
      const clean = name.replace(/^\.\//, '');
      if (clean.startsWith('/') || clean.split('/').includes('..'))
        throw new RangeError(`unsafe tar entry ${name}`);
      if (files.length >= limits.maxFiles) throw new RangeError('too many files in archive');
      files.push({ name: clean, data: raw.slice(at, at + size) });
    }
    at += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
