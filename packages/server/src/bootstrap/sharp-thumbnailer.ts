import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { Thumbnailer } from '@mindlog/services';
import sharp from 'sharp';

const SPEC = /^(\d+)x(\d+)([tbf]?)$/;

/** Thumbnails with sharp, whose work runs on libuv threads rather than the event loop (PLAN 16.5). */
export const sharpThumbnailer: Thumbnailer = {
  async resize(bytes, spec): Promise<Result<Uint8Array, MindlogError>> {
    const m = SPEC.exec(spec);
    if (!m) return err(mindlogError('INVALID_ARGUMENT', `invalid thumbnail ${spec}`));
    const [width, height] = [Number(m[1]), Number(m[2])];
    const mode = m[3];
    try {
      const out = await sharp(bytes)
        .rotate()
        .resize(width || undefined, height || undefined, {
          fit: mode === 'f' ? 'inside' : 'cover',
          position: mode === 't' ? 'top' : mode === 'b' ? 'bottom' : 'centre',
          withoutEnlargement: true,
        })
        .toBuffer();
      return ok(new Uint8Array(out));
    } catch (cause) {
      return err(mindlogError('INVALID_ARGUMENT', 'the file is not a readable image', { cause }));
    }
  },
};
