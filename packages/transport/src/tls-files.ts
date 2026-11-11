import { readFileSync, statSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import type { Logger, TlsIdentity, TlsProvider } from '@mindlog/core';

export interface TlsFilePaths {
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
}

const read = (paths: TlsFilePaths): TlsIdentity => ({
  ca: readFileSync(paths.ca, 'utf8'),
  cert: readFileSync(paths.cert, 'utf8'),
  key: readFileSync(paths.key, 'utf8'),
});

const stamp = (paths: TlsFilePaths): string =>
  [paths.ca, paths.cert, paths.key].map((p) => String(statSync(p).mtimeMs)).join(':');

/**
 * Certificates on disk, reloaded when a file changes (PLAN 18.4: rotation
 * without downtime). A set that does not parse, such as one read halfway
 * through a rotation, keeps the previous certificates in use.
 */
export class TlsFiles implements TlsProvider {
  readonly #listeners = new Set<(identity: TlsIdentity) => void>();
  #identity: TlsIdentity;
  #stamp: string;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly paths: TlsFilePaths,
    private readonly logger: Logger,
  ) {
    this.#identity = read(paths);
    createSecureContext(this.#identity);
    this.#stamp = stamp(paths);
  }

  identity(): TlsIdentity {
    return this.#identity;
  }

  subscribe(listener: (identity: TlsIdentity) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Reloads if a file changed. */
  check(): void {
    let current: string;
    try {
      current = stamp(this.paths);
    } catch {
      return; // mid-rotation; try again next time
    }
    if (current === this.#stamp) return;
    try {
      const next = read(this.paths);
      createSecureContext(next);
      this.#identity = next;
      this.#stamp = current;
    } catch (cause) {
      this.logger.warn('ignoring certificates that do not load', { err: cause });
      return;
    }
    this.logger.info('certificates reloaded', {});
    for (const listener of this.#listeners) listener(this.#identity);
  }

  watch(intervalMs: number): void {
    this.#timer ??= setInterval(() => {
      this.check();
    }, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
