#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { SystemClock, createLogger } from '@mindlog/core';
import { MaelstromNode } from './maelstrom-node.js';

/**
 * `mindlog-maelstrom`: a Maelstrom node (docs/references/maelstrom.md).
 * Messages are JSON lines on stdin/stdout; logs go to stderr.
 */
interface Envelope {
  src: string;
  dest: string;
  body: Record<string, unknown> & { type?: string; msg_id?: number };
}

const logger = createLogger({
  level: 'info',
  name: 'mindlog-maelstrom',
  destination: process.stderr,
});
let self = '';
let nextId = 1;
let node: MaelstromNode | undefined;

const send = (dest: string, body: Record<string, unknown>): void => {
  process.stdout.write(
    `${JSON.stringify({ src: self, dest, body: { ...body, msg_id: nextId++ } })}\n`,
  );
};

const reply = (to: Envelope, body: Record<string, unknown>): void => {
  send(to.src, { ...body, in_reply_to: to.body.msg_id });
};

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line) as Envelope;
  if (msg.body.type === 'init') {
    self = String(msg.body.node_id);
    node = await MaelstromNode.start(self, msg.body.node_ids as string[], send, {
      clock: new SystemClock(),
      logger,
    });
    reply(msg, { type: 'init_ok' });
    continue;
  }
  const current = node;
  if (!current) {
    reply(msg, { type: 'error', code: 11, text: 'not initialised' });
    continue;
  }
  if (current.receive(msg.body)) continue;
  void current.handle(msg.body).then((body) => {
    reply(msg, body);
  });
}
