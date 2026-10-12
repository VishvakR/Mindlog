import type { Socket } from 'node:net';
import { connect } from 'node:net';

const frame = (args: readonly string[]): Buffer =>
  Buffer.concat([
    Buffer.from(`*${String(args.length)}\r\n`),
    ...args.flatMap((a) => {
      const b = Buffer.from(a);
      return [Buffer.from(`$${String(b.length)}\r\n`), b, Buffer.from('\r\n')];
    }),
  ]);

/** Length of the first complete RESP2 reply in `text`, or -1. */
function replyLength(text: string, at = 0): number {
  const end = text.indexOf('\r\n', at);
  if (end < 0) return -1;
  const type = text[at];
  const n = Number(text.slice(at + 1, end));
  if (type === '$')
    return n < 0 ? end + 2 - at : end + 2 + n + 2 <= text.length ? end + 4 + n - at : -1;
  if (type === '*') {
    let pos = end + 2;
    for (let i = 0; i < n; i++) {
      const len = replyLength(text, pos);
      if (len < 0) return -1;
      pos += len;
    }
    return pos - at;
  }
  return end + 2 - at;
}

/** A minimal RESP2 client: one command at a time, replies as raw text. */
export async function respClient(port: number, host = '127.0.0.1') {
  const socket: Socket = connect(port, host);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve).once('error', reject);
  });
  let buffer = '';
  let waiting: (() => void) | undefined;
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('latin1');
    waiting?.();
  });
  return {
    async call(...args: string[]): Promise<string> {
      socket.write(frame(args));
      for (;;) {
        const length = replyLength(buffer);
        if (length >= 0) {
          const reply = buffer.slice(0, length);
          buffer = buffer.slice(length);
          return reply;
        }
        await new Promise<void>((resolve) => (waiting = resolve));
      }
    },
    close: () => new Promise<void>((resolve) => socket.end(resolve)),
  };
}
