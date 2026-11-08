import { createHash, createHmac } from 'node:crypto';
import type { Clock, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { BlobStore } from './blob-store.js';
import { checkKey } from './blob-store.js';

export interface S3Options {
  /** e.g. `http://minio:9000`; objects are addressed path-style, `/bucket/key`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly clock: Clock;
  /** Per request (default 10 s). */
  readonly timeoutMs?: number;
}

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** SigV4 signing key: HMAC chain over date, region, service and `aws4_request`. */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/** RFC 3986 encoding of one path segment, as SigV4 wants it. */
const encodeSegment = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `20261031T120000Z` of a time in ms. */
const amzDate = (ms: number): string => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');

/**
 * Headers of a SigV4-signed S3 request (AWS Signature Version 4, header
 * auth, `UNSIGNED` payloads not used). Only host, content hash and date are signed.
 */
export function signRequest(
  o: Pick<S3Options, 'region' | 'accessKeyId' | 'secretAccessKey'>,
  method: string,
  url: URL,
  body: Uint8Array,
  nowMs: number,
): Record<string, string> {
  const date = amzDate(nowMs);
  const day = date.slice(0, 8);
  const hash = sha256(body);
  const signed = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = [
    method,
    url.pathname,
    // SigV4 wants the query sorted and RFC 3986 encoded.
    [...url.searchParams]
      .map(([k, v]) => `${encodeSegment(k)}=${encodeSegment(v)}`)
      .sort()
      .join('&'),
    `host:${url.host}`,
    `x-amz-content-sha256:${hash}`,
    `x-amz-date:${date}`,
    '',
    signed,
    hash,
  ].join('\n');
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(o.secretAccessKey, day, o.region, 's3'))
    .update(toSign)
    .digest('hex');
  return {
    'x-amz-content-sha256': hash,
    'x-amz-date': date,
    authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

/** Blobs in an S3-compatible bucket (MinIO), over `fetch` with our own SigV4 (ADR-0033). */
export class S3BlobStore implements BlobStore {
  readonly #o: S3Options;

  constructor(options: S3Options) {
    this.#o = options;
  }

  async #request(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    body: Uint8Array = new Uint8Array(),
  ): Promise<Result<Response, MindlogError>> {
    const k = checkKey(key);
    if (!k.ok) return k;
    const path = [this.#o.bucket, ...key.split('/')].map(encodeSegment).join('/');
    const url = new URL(`/${path}`, this.#o.endpoint);
    const headers = signRequest(this.#o, method, url, body, Number(this.#o.clock.now()));
    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(method === 'PUT' ? { body: new Uint8Array(body) } : {}),
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 10_000),
      });
      return ok(res);
    } catch (cause) {
      return err(
        mindlogError('UNAVAILABLE', `blob store ${method} ${key}: ${String(cause)}`, { cause }),
      );
    }
  }

  async #fail(res: Response, what: string): Promise<Result<never, MindlogError>> {
    const text = (await res.text()).slice(0, 200);
    const code = res.status >= 500 ? 'UNAVAILABLE' : 'INTERNAL';
    return err(mindlogError(code, `blob store ${what}: HTTP ${String(res.status)} ${text}`));
  }

  async put(key: string, bytes: Uint8Array): Promise<Result<void, MindlogError>> {
    const res = await this.#request('PUT', key, bytes);
    if (!res.ok) return res;
    if (!res.value.ok) return this.#fail(res.value, `put ${key}`);
    await res.value.arrayBuffer();
    return ok(undefined);
  }

  async get(key: string): Promise<Result<Uint8Array | undefined, MindlogError>> {
    const res = await this.#request('GET', key);
    if (!res.ok) return res;
    if (res.value.status === 404) {
      await res.value.arrayBuffer();
      return ok(undefined);
    }
    if (!res.value.ok) return this.#fail(res.value, `get ${key}`);
    return ok(new Uint8Array(await res.value.arrayBuffer()));
  }

  async delete(key: string): Promise<Result<void, MindlogError>> {
    const res = await this.#request('DELETE', key);
    if (!res.ok) return res;
    if (!res.value.ok && res.value.status !== 404) return this.#fail(res.value, `delete ${key}`);
    await res.value.arrayBuffer();
    return ok(undefined);
  }

  /** ListObjectsV2, page by page. */
  async list(prefix: string): Promise<Result<string[], MindlogError>> {
    const k = checkKey(prefix);
    if (!k.ok) return k;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const url = new URL(`/${encodeSegment(this.#o.bucket)}`, this.#o.endpoint);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', `${prefix}/`);
      if (token !== undefined) url.searchParams.set('continuation-token', token);
      const empty = new Uint8Array();
      const headers = signRequest(this.#o, 'GET', url, empty, Number(this.#o.clock.now()));
      let res: Response;
      try {
        res = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(this.#o.timeoutMs ?? 10_000),
        });
      } catch (cause) {
        return err(mindlogError('UNAVAILABLE', `blob store list: ${String(cause)}`, { cause }));
      }
      if (!res.ok) return this.#fail(res, `list ${prefix}`);
      const xml = await res.text();
      // Keys are limited to [A-Za-z0-9._-/] by checkKey, so no XML entities appear in them.
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1] ?? '');
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/
            .exec(xml)?.[1]
            ?.replace(/&amp;/g, '&')
        : undefined;
    } while (token !== undefined);
    return ok(keys.sort());
  }
}
