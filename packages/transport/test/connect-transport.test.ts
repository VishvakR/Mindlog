import { create } from '@bufbuild/protobuf';
import { MemoryLogger, MemoryMetrics } from '@mindlog/core';
import type { NodeInboundHandler } from '@mindlog/multiraft';
import type { KeyValue, Message } from '@mindlog/proto';
import { MessageSchema, MessageType } from '@mindlog/proto';
import { ConnectTransport } from '@mindlog/transport';
import { afterEach, describe, expect, test } from 'vitest';

const opened: ConnectTransport[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((t) => t.close()));
});

async function start(): Promise<ConnectTransport> {
  const t = await ConnectTransport.start({
    host: '127.0.0.1',
    port: 0,
    reconnectMs: 20,
    logger: new MemoryLogger(),
    metrics: new MemoryMetrics(),
  });
  opened.push(t);
  return t;
}

function recorder() {
  const messages: Message[] = [];
  const senders: string[] = [];
  const snapshots: Array<{ message: Message; pairs: readonly KeyValue[] }> = [];
  const unreachable: string[] = [];
  const handler: NodeInboundHandler = {
    onMessages: (m, from) => {
      messages.push(...m);
      senders.push(from);
    },
    onSnapshot: (message, pairs) => snapshots.push({ message, pairs }),
    onUnreachable: (address) => unreachable.push(address),
  };
  return { handler, messages, senders, snapshots, unreachable };
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const msg = (to: bigint, index: bigint): Message =>
  create(MessageSchema, { type: MessageType.APPEND, from: 1n, to, term: 1n, index });

describe('ConnectTransport', () => {
  test('delivers batches in order over one stream per peer node, with the sender address', async () => {
    const a = await start();
    const b = await start();
    const rb = recorder();
    b.attach(rb.handler);
    a.send(b.self, [msg(2n, 1n), msg(2n, 2n)]);
    a.send(b.self, [msg(3n, 3n)]);
    await until(() => rb.messages.length === 3);
    expect(rb.messages.map((m) => m.index)).toEqual([1n, 2n, 3n]);
    expect(new Set(rb.senders)).toEqual(new Set([a.self]));
  });

  test('streams a snapshot in chunks', async () => {
    const a = await start();
    const b = await start();
    const rb = recorder();
    b.attach(rb.handler);
    const pair = (n: number): KeyValue => ({
      $typeName: 'mindlog.v1.KeyValue',
      key: Uint8Array.of(n),
      value: new Uint8Array(1000).fill(n),
    });
    async function* chunks() {
      yield await Promise.resolve([pair(1), pair(2)]);
      yield [pair(3)];
    }
    const snap = create(MessageSchema, {
      type: MessageType.SNAPSHOT,
      from: 1n,
      to: 2n,
      snapshot: { index: 9n },
    });
    expect(await a.sendSnapshot(b.self, snap, chunks())).toBe(true);
    expect(rb.snapshots).toHaveLength(1);
    expect(rb.snapshots[0]?.message.snapshot?.index).toBe(9n);
    expect(rb.snapshots[0]?.pairs.map((p) => p.key[0])).toEqual([1, 2, 3]);
  });

  test('reports an unreachable peer, drops while it is down, and reconnects when it is back', async () => {
    const a = await start();
    const ra = recorder();
    a.attach(ra.handler);
    const b = await start();
    const port = b.address.port;
    await b.close();
    opened.splice(opened.indexOf(b), 1);
    const address = `127.0.0.1:${port}`;
    a.send(address, [msg(2n, 1n)]);
    await until(() => ra.unreachable.includes(address));
    const snap = create(MessageSchema, { type: MessageType.SNAPSHOT, from: 1n, to: 2n });
    expect(await a.sendSnapshot(address, snap, (async function* () {})())).toBe(false);

    const back = await ConnectTransport.start({
      host: '127.0.0.1',
      port,
      logger: new MemoryLogger(),
      metrics: new MemoryMetrics(),
    });
    opened.push(back);
    const rb = recorder();
    back.attach(rb.handler);
    await until(() => {
      a.send(address, [msg(2n, 7n)]);
      return rb.messages.some((m) => m.index === 7n);
    });
  });
});
