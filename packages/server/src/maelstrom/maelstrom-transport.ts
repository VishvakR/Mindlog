import { fromBinary, toBinary } from '@bufbuild/protobuf';
import type { InboundHandler, RaftTransport } from '@mindlog/multiraft';
import type { KeyValue, Message } from '@mindlog/proto';
import { KeyValueSchema, MessageSchema } from '@mindlog/proto';

/** Sends one Maelstrom message (a JSON line on stdout). */
export type MaelstromSend = (dest: string, body: Record<string, unknown>) => void;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

/**
 * Raft over Maelstrom's simulated network: each Raft message is a
 * `{type: "raft", data}` body with base64 protobuf, so Maelstrom's partitions
 * and latency apply to it (docs/references/maelstrom.md).
 */
export class MaelstromTransport implements RaftTransport {
  readonly #send: MaelstromSend;
  #handler: InboundHandler | undefined;

  constructor(send: MaelstromSend) {
    this.#send = send;
  }

  attach(handler: InboundHandler): void {
    this.#handler = handler;
  }

  send(messages: readonly Message[]): void {
    for (const m of messages)
      this.#send(`n${m.to - 1n}`, { type: 'raft', data: b64(toBinary(MessageSchema, m)) });
  }

  async sendSnapshot(message: Message, chunks: AsyncIterable<KeyValue[]>): Promise<boolean> {
    const pairs: string[] = [];
    for await (const chunk of chunks)
      for (const kv of chunk) pairs.push(b64(toBinary(KeyValueSchema, kv)));
    this.#send(`n${message.to - 1n}`, {
      type: 'raft_snapshot',
      message: b64(toBinary(MessageSchema, message)),
      pairs,
    });
    return true;
  }

  setPeers(): void {}

  /** Handles a node-to-node body; returns false when it is not a Raft message. */
  receive(body: { type?: unknown; data?: unknown; message?: unknown; pairs?: unknown }): boolean {
    if (body.type === 'raft' && typeof body.data === 'string') {
      this.#handler?.onMessages([fromBinary(MessageSchema, unb64(body.data))]);
      return true;
    }
    if (
      body.type === 'raft_snapshot' &&
      typeof body.message === 'string' &&
      Array.isArray(body.pairs)
    ) {
      const pairs = (body.pairs as string[]).map((p) => fromBinary(KeyValueSchema, unb64(p)));
      this.#handler?.onSnapshot(fromBinary(MessageSchema, unb64(body.message)), pairs);
      return true;
    }
    return false;
  }
}
