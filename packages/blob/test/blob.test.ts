import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  LocalBlobStore,
  MemoryBlobStore,
  S3BlobStore,
  signRequest,
  signingKey,
} from '@mindlog/blob';
import { SystemClock } from '@mindlog/core';
import { blobContract } from './blob-contract.js';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('BlobStore', () => {
  blobContract('memory', () => Promise.resolve(new MemoryBlobStore()));
  blobContract('local', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mindlog-blob-'));
    dirs.push(dir);
    return new LocalBlobStore(dir);
  });
  // Opt-in against MinIO: BLOB_S3=http://127.0.0.1:9000 (bucket `mindlog`, minioadmin keys).
  const s3 = process.env.BLOB_S3;
  if (s3)
    blobContract(
      's3',
      () =>
        Promise.resolve(
          new S3BlobStore({
            endpoint: s3,
            bucket: process.env.BLOB_S3_BUCKET ?? 'mindlog',
            region: 'us-east-1',
            accessKeyId: process.env.BLOB_S3_KEY ?? 'minioadmin',
            secretAccessKey: process.env.BLOB_S3_SECRET ?? 'minioadmin',
            clock: new SystemClock(),
          }),
        ),
      `test-${String(Date.now())}/`,
    );
});

describe('SigV4', () => {
  test('derives the signing key of the AWS documentation example', () => {
    const key = signingKey(
      'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      '20120215',
      'us-east-1',
      'iam',
    );
    expect(key.toString('hex')).toBe(
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
    );
  });
});

/**
 * A local S3 stand-in: path-style objects in a map, and every request's
 * Authorization recomputed from its own headers, so a wrong signature fails.
 */
async function fakeS3(opts: { fail?: number } = {}) {
  const objects = new Map<string, Uint8Array>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = new Uint8Array(Buffer.concat(chunks));
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? ''}`);
      const date = String(req.headers['x-amz-date'] ?? '');
      const at = Date.UTC(
        Number(date.slice(0, 4)),
        Number(date.slice(4, 6)) - 1,
        Number(date.slice(6, 8)),
        Number(date.slice(9, 11)),
        Number(date.slice(11, 13)),
        Number(date.slice(13, 15)),
      );
      const expected = signRequest(CREDS, req.method ?? '', url, body, at).authorization;
      if (opts.fail) {
        res.writeHead(opts.fail).end('broken');
        return;
      }
      if (req.headers.authorization !== expected) {
        res.writeHead(403).end('SignatureDoesNotMatch');
        return;
      }
      const key = decodeURIComponent(url.pathname);
      if (req.method === 'PUT') {
        objects.set(key, body);
        res.writeHead(200).end();
      } else if (req.method === 'GET') {
        const o = objects.get(key);
        if (o) res.writeHead(200).end(Buffer.from(o));
        else res.writeHead(404).end('NoSuchKey');
      } else {
        objects.delete(key);
        res.writeHead(204).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${String(port)}`, objects };
}

const CREDS = { region: 'us-east-1', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret/test+key' };
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

describe('S3BlobStore against a signature-checking fake', () => {
  blobContract('s3 (fake)', async () => {
    const { endpoint } = await fakeS3();
    return new S3BlobStore({ ...CREDS, endpoint, bucket: 'mindlog', clock: new SystemClock() });
  });

  test('a wrong secret is refused, and a server error is UNAVAILABLE', async () => {
    const { endpoint } = await fakeS3();
    const wrong = new S3BlobStore({
      ...CREDS,
      secretAccessKey: 'nope',
      endpoint,
      bucket: 'mindlog',
      clock: new SystemClock(),
    });
    const put = await wrong.put('a/b', new Uint8Array([1]));
    expect(!put.ok && put.error.message).toMatch(/HTTP 403/);
    const broken = await fakeS3({ fail: 503 });
    const s = new S3BlobStore({
      ...CREDS,
      endpoint: broken.endpoint,
      bucket: 'b',
      clock: new SystemClock(),
    });
    for (const r of [await s.put('k', new Uint8Array()), await s.get('k'), await s.delete('k')])
      expect(!r.ok && r.error.code).toBe('UNAVAILABLE');
  });

  test('an unreachable endpoint is UNAVAILABLE', async () => {
    const s = new S3BlobStore({
      ...CREDS,
      endpoint: 'http://127.0.0.1:1',
      bucket: 'b',
      clock: new SystemClock(),
      timeoutMs: 2000,
    });
    const r = await s.get('k');
    expect(!r.ok && r.error.code).toBe('UNAVAILABLE');
  });
});
