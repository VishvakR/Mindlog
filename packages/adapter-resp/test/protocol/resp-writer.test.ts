import { describe, expect, test } from 'vitest';
import type { KvReply } from '@mindlog/proto';
import type { ProtocolVersion } from '@mindlog/adapter-resp';
import { RespWriter } from '@mindlog/adapter-resp';
import { replies } from '@mindlog/kv';

const bytes = (s: string) => Buffer.from(s, 'latin1');
const encode = (reply: KvReply, protocol: ProtocolVersion) => {
  const writer = new RespWriter();
  writer.write(reply, protocol);
  return writer.take().toString('latin1');
};
const both = (reply: KvReply) => [encode(reply, 3), encode(reply, 2)];

describe('RespWriter golden bytes (RESP3, RESP2)', () => {
  test('scalars', () => {
    expect(both(replies.nil())).toEqual(['_\r\n', '$-1\r\n']);
    expect(both(replies.ok())).toEqual(['+OK\r\n', '+OK\r\n']);
    expect(both(replies.integer(-42n))).toEqual([':-42\r\n', ':-42\r\n']);
    expect(both(replies.bulk(bytes('a\r\nb')))).toEqual(['$4\r\na\r\nb\r\n', '$4\r\na\r\nb\r\n']);
    expect(both(replies.bulk(new Uint8Array()))).toEqual(['$0\r\n\r\n', '$0\r\n\r\n']);
  });

  test('doubles: RESP3 native, RESP2 bulk', () => {
    expect(both(replies.double(1.5))).toEqual([',1.5\r\n', '$3\r\n1.5\r\n']);
    expect(both(replies.double(Infinity))).toEqual([',inf\r\n', '$3\r\ninf\r\n']);
    expect(both(replies.double(-Infinity))).toEqual([',-inf\r\n', '$4\r\n-inf\r\n']);
    expect(encode(replies.double(NaN), 3)).toBe(',nan\r\n');
  });

  test('aggregates', () => {
    const arr = replies.array([replies.integer(1), replies.bulk(bytes('x'))]);
    expect(both(arr)).toEqual(['*2\r\n:1\r\n$1\r\nx\r\n', '*2\r\n:1\r\n$1\r\nx\r\n']);
    expect(both(replies.set([replies.bulk(bytes('a'))]))).toEqual([
      '~1\r\n$1\r\na\r\n',
      '*1\r\n$1\r\na\r\n',
    ]);
    const map = replies.map([[replies.bulk(bytes('k')), replies.integer(7)]]);
    expect(both(map)).toEqual(['%1\r\n$1\r\nk\r\n:7\r\n', '*2\r\n$1\r\nk\r\n:7\r\n']);
    expect(both(replies.array([]))).toEqual(['*0\r\n', '*0\r\n']);
  });

  test('score pairs nest in RESP3 and flatten in RESP2', () => {
    const pairs = replies.pairs([
      [replies.bulk(bytes('a')), replies.double(1)],
      [replies.bulk(bytes('b')), replies.double(2.5)],
    ]);
    expect(both(pairs)).toEqual([
      '*2\r\n*2\r\n$1\r\na\r\n,1\r\n*2\r\n$1\r\nb\r\n,2.5\r\n',
      '*4\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n$3\r\n2.5\r\n',
    ]);
  });

  test('errors take their prefix from the error table', () => {
    expect(encode(replies.errors.wrongType(), 3)).toBe(
      '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n',
    );
    expect(encode(replies.errors.syntax(), 2)).toBe('-ERR syntax error\r\n');
    expect(encode(replies.error('BUSY', 'queue full'), 2)).toBe('-BUSY queue full\r\n');
  });

  test('line breaks in simple strings and errors become spaces', () => {
    expect(encode(replies.simple('a\r\nb'), 3)).toBe('+a  b\r\n');
    expect(encode(replies.error('INTERNAL', 'x\ny'), 3)).toBe('-ERR x y\r\n');
  });

  test('UTF-8 text keeps its bytes', () => {
    expect(new RespWriter().length).toBe(0);
    const writer = new RespWriter();
    writer.write(replies.simple('héllo'), 3);
    expect(writer.take()).toEqual(Buffer.from('+héllo\r\n', 'utf8'));
  });

  test('replies accumulate until taken, and the buffer grows for large bulks', () => {
    const writer = new RespWriter();
    const big = Buffer.alloc(100_000, 0x62);
    writer.write(replies.ok(), 3);
    writer.write(replies.bulk(big), 3);
    const out = writer.take();
    expect(out.length).toBe(5 + 9 + 100_000 + 2);
    expect(out.subarray(0, 14).toString('latin1')).toBe('+OK\r\n$100000\r\n');
    expect(writer.length).toBe(0);
    writer.write(replies.integer(1), 2);
    expect(writer.take().toString('latin1')).toBe(':1\r\n');
  });
});
