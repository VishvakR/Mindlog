import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { BlobStore } from './blob-store.js';

const MAGIC = 0xe1;
const NONCE = 12;
const TAG = 16;
const encoder = new TextEncoder();

/** `cold/<tenant>/…`, `files/<tenant>/…`: the second segment names the tenant. */
const tenantOf = (key: string): string => key.split('/')[1] ?? '';

/**
 * Blobs sealed with AES-256-GCM (ADR-0014). A blob store can be shared by every
 * node (S3), so each tenant's key is derived from the master key, which every
 * node of a cluster holds, rather than kept in one node's keyring. The blob
 * key is bound in as associated data, so a blob cannot be renamed into place.
 */
export class EncryptingBlobStore implements BlobStore {
  readonly #keys = new Map<string, Buffer>();

  constructor(
    private readonly inner: BlobStore,
    private readonly master: Uint8Array,
  ) {}

  #key(tenant: string): Buffer {
    let key = this.#keys.get(tenant);
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', this.master, 'mindlog-blob', tenant, 32));
      this.#keys.set(tenant, key);
    }
    return key;
  }

  put(key: string, bytes: Uint8Array): Promise<Result<void, MindlogError>> {
    const nonce = randomBytes(NONCE);
    const cipher = createCipheriv('aes-256-gcm', this.#key(tenantOf(key)), nonce);
    cipher.setAAD(encoder.encode(key));
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const sealed = Buffer.concat([Buffer.of(MAGIC), nonce, body, cipher.getAuthTag()]);
    return this.inner.put(key, new Uint8Array(sealed.buffer, sealed.byteOffset, sealed.length));
  }

  async get(key: string): Promise<Result<Uint8Array | undefined, MindlogError>> {
    const got = await this.inner.get(key);
    if (!got.ok || got.value === undefined) return got;
    const sealed = Buffer.from(got.value.buffer, got.value.byteOffset, got.value.length);
    if (sealed.length < 1 + NONCE + TAG || sealed[0] !== MAGIC)
      return err(mindlogError('INTERNAL', `blob ${key} is not encrypted`));
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#key(tenantOf(key)),
        sealed.subarray(1, 1 + NONCE),
      );
      decipher.setAAD(encoder.encode(key));
      decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
      const plain = Buffer.concat([
        decipher.update(sealed.subarray(1 + NONCE, sealed.length - TAG)),
        decipher.final(),
      ]);
      return ok(new Uint8Array(plain.buffer, plain.byteOffset, plain.length));
    } catch (cause) {
      return err(mindlogError('INTERNAL', `blob ${key} does not decrypt`, { cause }));
    }
  }

  delete(key: string): Promise<Result<void, MindlogError>> {
    return this.inner.delete(key);
  }

  list(prefix: string): Promise<Result<string[], MindlogError>> {
    return this.inner.list(prefix);
  }
}
