import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { ParseEvent } from '@mindlog/adapter-resp';
import { RespParser } from '@mindlog/adapter-resp';

const text = (events: ParseEvent[]) =>
  events.map((e) =>
    e.kind === 'error'
      ? `ERR:${e.message}`
      : e.argv.map((a) => Buffer.from(a).toString('latin1')).join(' '),
  );

const frame = (...args: (string | Buffer)[]) =>
  Buffer.concat([
    Buffer.from(`*${args.length}\r\n`),
    ...args.flatMap((a) => {
      const b = Buffer.isBuffer(a) ? a : Buffer.from(a, 'latin1');
      return [Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')];
    }),
  ]);

/** Feeds `bytes` split at the given cut points, as node-redis tests do byte by byte. */
function feed(bytes: Buffer, cuts: number[] = []): ParseEvent[] {
  const parser = new RespParser();
  const points = [...new Set(cuts.filter((c) => c > 0 && c < bytes.length))].sort((a, b) => a - b);
  const events: ParseEvent[] = [];
  let last = 0;
  for (const cut of [...points, bytes.length]) {
    events.push(...parser.push(bytes.subarray(last, cut)));
    last = cut;
  }
  return events;
}

describe('RespParser: multibulk', () => {
  test('one command in a single chunk and byte by byte', () => {
    const bytes = frame('SET', 'key', 'value');
    expect(text(feed(bytes))).toEqual(['SET key value']);
    expect(
      text(
        feed(
          bytes,
          Array.from({ length: bytes.length }, (_, i) => i),
        ),
      ),
    ).toEqual(['SET key value']);
  });

  test('pipelined commands, binary data and empty bulks', () => {
    const binary = Buffer.from([0x00, 0x0d, 0x0a, 0xff]);
    const bytes = Buffer.concat([frame('PING'), frame('SET', 'k', binary), frame('GET', '')]);
    const events = feed(bytes);
    expect(events).toHaveLength(3);
    const second = events[1];
    expect(second?.kind === 'command' && Buffer.from(second.argv[2] ?? []).equals(binary)).toBe(
      true,
    );
    expect(text(events)[2]).toBe('GET ');
  });

  test('empty multibulk requests are ignored', () => {
    expect(text(feed(Buffer.concat([Buffer.from('*0\r\n*-1\r\n'), frame('PING')])))).toEqual([
      'PING',
    ]);
  });

  test('any split of any pipeline yields the same commands', () => {
    const arg = fc.uint8Array({ maxLength: 20 }).map((a) => Buffer.from(a));
    const command = fc.array(arg, { minLength: 1, maxLength: 5 });
    fc.assert(
      fc.property(
        fc.array(command, { minLength: 1, maxLength: 5 }),
        fc.array(fc.nat(500)),
        (commands, cuts) => {
          const bytes = Buffer.concat(commands.map((c) => frame(...c)));
          const events = feed(bytes, cuts);
          expect(
            events.map((e) =>
              e.kind === 'command' ? e.argv.map((a) => Buffer.from(a).toString('hex')) : e,
            ),
          ).toEqual(commands.map((c) => c.map((a) => a.toString('hex'))));
        },
      ),
    );
  });

  test('protocol errors follow Valkey', () => {
    expect(text(feed(Buffer.from('*abc\r\n')))).toEqual([
      'ERR:Protocol error: invalid multibulk length',
    ]);
    expect(text(feed(Buffer.from('*1\r\n+x\r\n')))).toEqual([
      "ERR:Protocol error: expected '$', got '+'",
    ]);
    expect(text(feed(Buffer.from('*1\r\n$-5\r\n')))).toEqual([
      'ERR:Protocol error: invalid bulk length',
    ]);
  });

  test('headers end at CR and are strict integers, as in Valkey string2ll', () => {
    expect(text(feed(Buffer.from('*\r\n')))).toEqual([
      'ERR:Protocol error: invalid multibulk length',
    ]);
    expect(text(feed(Buffer.from('* 1\r\n')))).toEqual([
      'ERR:Protocol error: invalid multibulk length',
    ]);
    expect(text(feed(Buffer.from('*0x1\r\n')))).toEqual([
      'ERR:Protocol error: invalid multibulk length',
    ]);
    expect(text(feed(Buffer.from('*1\r\n$1e0\r\nx\r\n')))).toEqual([
      'ERR:Protocol error: invalid bulk length',
    ]);
    expect(text(feed(Buffer.from('*1\r\n$01\r\nx\r\n')))).toEqual([
      'ERR:Protocol error: invalid bulk length',
    ]);
  });

  test('a bare LF does not end a multibulk header (fuzz regression)', () => {
    const bytes = Buffer.from('*1\r\n$5\n\x00\x00\x00\r\n', 'latin1');
    expect(text(feed(bytes))).toEqual(['ERR:Protocol error: invalid bulk length']);
    expect(text(feed(bytes, [7]))).toEqual(['ERR:Protocol error: invalid bulk length']);
  });

  test('a protocol error stops the parser', () => {
    const parser = new RespParser();
    expect(parser.push(Buffer.from('*x\r\n'))).toHaveLength(1);
    expect(parser.push(frame('PING'))).toEqual([]);
  });

  test('limits on bulk size, argument count and header length', () => {
    const tight = new RespParser({ maxBulkBytes: 4, maxInlineBytes: 16, maxArgs: 2 });
    expect(text(tight.push(Buffer.from('*1\r\n$5\r\n')))).toEqual([
      'ERR:Protocol error: invalid bulk length',
    ]);
    expect(
      text(
        new RespParser({ maxBulkBytes: 4, maxInlineBytes: 16, maxArgs: 2 }).push(
          Buffer.from('*3\r\n'),
        ),
      ),
    ).toEqual(['ERR:Protocol error: invalid multibulk length']);
    expect(
      text(
        new RespParser({ maxBulkBytes: 4, maxInlineBytes: 16, maxArgs: 2 }).push(
          Buffer.from(`*${'1'.repeat(40)}`),
        ),
      ),
    ).toEqual(['ERR:Protocol error: too big mbulk count string']);
  });

  test('a large bulk arriving in many chunks', () => {
    const big = Buffer.alloc(300_000, 0x61);
    const bytes = frame('SET', 'k', big);
    const cuts = Array.from({ length: 60 }, (_, i) => (i + 1) * 5000);
    const events = feed(bytes, cuts);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === 'command' && events[0].argv[2]?.length).toBe(300_000);
  });
});

describe('RespParser: inline commands', () => {
  test('spaces, quotes and escapes like sdssplitargs', () => {
    expect(text(feed(Buffer.from('PING\r\n')))).toEqual(['PING']);
    expect(text(feed(Buffer.from('  SET  k   v \n')))).toEqual(['SET k v']);
    expect(text(feed(Buffer.from('SET k "a b\\n\\x41"\r\n')))).toEqual(['SET k a b\nA']);
    expect(text(feed(Buffer.from("SET k 'it\\'s'\r\n")))).toEqual(["SET k it's"]);
    expect(text(feed(Buffer.from('SET k ""\r\n')))).toEqual(['SET k ']);
  });

  test('empty lines are skipped; malformed lines are protocol errors', () => {
    expect(text(feed(Buffer.from('\r\n\r\nPING\r\n')))).toEqual(['PING']);
    expect(text(feed(Buffer.from('SET k "unbalanced\r\n')))).toEqual([
      'ERR:Protocol error: unbalanced quotes in request',
    ]);
    expect(text(feed(Buffer.from('SET k "a"b\r\n')))).toEqual([
      'ERR:Protocol error: unbalanced quotes in request',
    ]);
    const tight = new RespParser({ maxBulkBytes: 10, maxInlineBytes: 8, maxArgs: 10 });
    expect(text(tight.push(Buffer.from('SET aaaaaaaaaaaaaa')))).toEqual([
      'ERR:Protocol error: too big inline request',
    ]);
  });
});

describe('RespParser: robustness', () => {
  test('arbitrary bytes never throw', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 64 }), { maxLength: 8 }), (chunks) => {
        const parser = new RespParser();
        expect(() => {
          for (const chunk of chunks) parser.push(Buffer.from(chunk));
        }).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });
});
