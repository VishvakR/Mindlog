import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { BlobStore } from './blob-store.js';
import { checkKey } from './blob-store.js';

const io = (what: string, cause: unknown): Result<never, MindlogError> =>
  err(
    mindlogError('INTERNAL', `${what}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    }),
  );

/** Blobs as files under a root directory; a put is written, fsynced, then renamed into place. */
export class LocalBlobStore implements BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async put(key: string, bytes: Uint8Array): Promise<Result<void, MindlogError>> {
    const k = checkKey(key);
    if (!k.ok) return k;
    const path = join(this.#root, key);
    const tmp = `${path}.${String(process.pid)}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      const file = await open(tmp, 'w');
      try {
        await file.write(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
      return ok(undefined);
    } catch (cause) {
      return io(`cannot write blob ${key}`, cause);
    }
  }

  async get(key: string): Promise<Result<Uint8Array | undefined, MindlogError>> {
    const k = checkKey(key);
    if (!k.ok) return k;
    try {
      return ok(new Uint8Array(await readFile(join(this.#root, key))));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined);
      return io(`cannot read blob ${key}`, cause);
    }
  }

  async delete(key: string): Promise<Result<void, MindlogError>> {
    const k = checkKey(key);
    if (!k.ok) return k;
    try {
      await rm(join(this.#root, key), { force: true });
      return ok(undefined);
    } catch (cause) {
      return io(`cannot delete blob ${key}`, cause);
    }
  }

  async list(prefix: string): Promise<Result<string[], MindlogError>> {
    const k = checkKey(prefix);
    if (!k.ok) return k;
    try {
      const entries = await readdir(join(this.#root, prefix), {
        recursive: true,
        withFileTypes: true,
      });
      const keys = entries
        .filter((e) => e.isFile() && !e.name.endsWith('.tmp'))
        .map((e) => relative(this.#root, join(e.parentPath, e.name)).split(sep).join('/'));
      return ok(keys.sort());
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok([]);
      return io(`cannot list blobs ${prefix}`, cause);
    }
  }
}
