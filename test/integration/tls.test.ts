import { readFileSync, writeFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { connect } from 'node:tls';
import { MemoryLogger, MemoryMetrics, resolveConfig } from '@mindlog/core';
import { MessageSchema, MessageType } from '@mindlog/proto';
import { redactedSettings } from '@mindlog/server';
import { ConnectTransport, TlsFiles } from '@mindlog/transport';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CertSet } from '../support/certs.js';
import { makeCerts } from '../support/certs.js';
import { startTestNode } from '../support/node.js';

/** PLAN 18.4: TLS on client listeners, mutual TLS between nodes, rotation without downtime. */

let certs: CertSet;
let foreign: CertSet;
const logger = new MemoryLogger();

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeAll(() => {
  certs = makeCerts();
  foreign = makeCerts('foreign');
});
afterAll(() => {
  certs.remove();
  foreign.remove();
});

const fingerprint = (host: string, port: number, ca: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port, ca, servername: 'localhost' }, () => {
      const seen = socket.getPeerCertificate().fingerprint256;
      socket.end();
      resolve(seen);
    });
    socket.on('error', reject);
  });

describe('the production profile', () => {
  test('refuses to start without TLS', () => {
    const r = resolveConfig({ flags: { profile: 'production' } });
    expect(!r.ok && r.error.fields).toHaveProperty(['tls.enabled']);
  });

  test('needs the certificate paths once TLS is on', () => {
    const r = resolveConfig({ flags: { tls: { enabled: true } } });
    expect(!r.ok && Object.keys(r.error.fields ?? {}).sort()).toEqual([
      'tls.ca',
      'tls.cert',
      'tls.key',
    ]);
  });
});

describe('a node with TLS', () => {
  let node: Awaited<ReturnType<typeof startTestNode>>;
  beforeAll(async () => {
    node = await startTestNode({
      profile: 'production',
      tls: { enabled: true, ca: certs.ca, cert: certs.cert, key: certs.key, reloadMs: 20 },
      limits: { authBurst: 10_000 },
    });
  });
  afterAll(async () => {
    await node.stop();
  });

  const ca = () => readFileSync(certs.ca, 'utf8');

  test('serves RESP over TLS and requires a credential', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(
        { host: '127.0.0.1', port: node.port, ca: ca(), servername: 'localhost' },
        () => {
          socket.write('*2\r\n$3\r\nGET\r\n$1\r\na\r\n');
        },
      );
      socket.once('data', (d: Buffer) => {
        socket.end();
        resolve(d.toString());
      });
      socket.on('error', reject);
    });
    expect(reply).toMatch(/NOAUTH|UNAUTHENTICATED/);
  });

  test('refuses plaintext RESP', async () => {
    const client = new Redis({
      port: node.port,
      host: '127.0.0.1',
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    await client.connect().catch(() => undefined);
    await expect(client.ping()).rejects.toThrow();
    client.disconnect();
  });

  test('serves HTTPS', async () => {
    const res = await new Promise<number>((resolve, reject) => {
      const socket = connect(
        { host: '127.0.0.1', port: node.node.http.port, ca: ca(), servername: 'localhost' },
        () => {
          socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
        },
      );
      let text = '';
      socket.on('data', (d: Buffer) => (text += d.toString()));
      socket.on('end', () => {
        resolve(Number(text.split(' ')[1]));
      });
      socket.on('error', reject);
    });
    expect(res).toBe(200);
  });

  test('a rotated certificate is served without a restart, and a broken one is ignored', async () => {
    const before = await fingerprint('127.0.0.1', node.port, ca());
    certs.rotate();
    let after = before;
    for (let i = 0; i < 100 && after === before; i++) {
      await new Promise((r) => setTimeout(r, 20));
      after = await fingerprint('127.0.0.1', node.port, ca());
    }
    expect(after).not.toBe(before);
    writeFileSync(certs.cert, 'not a certificate');
    await new Promise((r) => setTimeout(r, 100));
    expect(await fingerprint('127.0.0.1', node.port, ca())).toBe(after);
    certs.rotate();
  });
});

describe('node-to-node mutual TLS', () => {
  test('two nodes of one cluster exchange messages, also after a rotation', async () => {
    const files = new TlsFiles(certs, logger);
    const peer = (tls: TlsFiles) =>
      ConnectTransport.start({
        host: '127.0.0.1',
        port: 0,
        reconnectMs: 20,
        logger,
        metrics: new MemoryMetrics(),
        tls,
      });
    const a = await peer(files);
    const b = await peer(new TlsFiles(certs, logger));
    const got: bigint[] = [];
    b.attach({
      onMessages: (m) => got.push(...m.map((x) => x.index)),
      onSnapshot: () => undefined,
      onUnreachable: () => undefined,
    });
    const msg = (index: bigint) =>
      create(MessageSchema, { type: MessageType.APPEND, from: 1n, to: 2n, term: 1n, index });
    a.send(b.self, [msg(1n)]);
    await until(() => got.length === 1);
    certs.rotate();
    files.check();
    a.send(b.self, [msg(2n)]);
    await until(() => got.includes(2n));
    await Promise.all([a.close(), b.close()]);
  });

  const transport = (c: CertSet) =>
    ConnectTransport.start({
      host: '127.0.0.1',
      port: 0,
      logger,
      metrics: new MemoryMetrics(),
      tls: new TlsFiles(c, logger),
    });

  test('a peer without a cluster certificate cannot connect', async () => {
    const server = await transport(certs);
    const port = server.address.port;
    await expect(
      new Promise((resolve, reject) => {
        const socket = connect(
          {
            host: '127.0.0.1',
            port,
            ca: readFileSync(certs.ca, 'utf8'),
            servername: 'localhost',
            ALPNProtocols: ['h2'],
          },
          () => {
            socket.once('data', resolve);
            socket.once('close', () => {
              reject(new Error('closed'));
            });
            socket.write('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
          },
        );
        socket.on('error', reject);
      }),
    ).rejects.toThrow();
    await expect(
      new Promise((resolve, reject) => {
        const identity = new TlsFiles(foreign, logger).identity();
        const socket = connect(
          {
            host: '127.0.0.1',
            port,
            ca: readFileSync(certs.ca, 'utf8'),
            key: identity.key,
            cert: identity.cert,
            servername: 'localhost',
            ALPNProtocols: ['h2'],
          },
          () => {
            socket.once('data', resolve);
            socket.once('close', () => {
              reject(new Error('closed'));
            });
            socket.write('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
          },
        );
        socket.on('error', reject);
      }),
    ).rejects.toThrow();
    await server.close();
  });
});

test('settings never show a secret, including S3 keys', () => {
  const config = resolveConfig({
    flags: {
      auth: { password: 'p1p1p1p1p1' },
      blob: {
        default: {
          type: 's3',
          endpoint: 'http://x',
          bucket: 'b',
          accessKeyId: 'AKIA-SECRET',
          secretAccessKey: 'SECRET-VALUE',
        },
      },
    },
  });
  if (!config.ok) throw new Error(config.error.message);
  const text = JSON.stringify(redactedSettings(config.value));
  expect(text).not.toContain('SECRET-VALUE');
  expect(text).not.toContain('AKIA-SECRET');
  expect(text).not.toContain('p1p1p1p1p1');
});
