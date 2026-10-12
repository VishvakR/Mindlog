import { describe, expect, test } from 'vitest';
import { ReplyDecoder, encodeCommand, formatReply, splitArgs } from './resp';

const bytes = (s: string) => new TextEncoder().encode(s);
const decodeAll = (s: string) => new ReplyDecoder().push(bytes(s));

describe('splitArgs', () => {
  test('splits like redis-cli', () => {
    expect(splitArgs('SET  key "hello world"')).toEqual(['SET', 'key', 'hello world']);
    expect(splitArgs(`SET k 'it''s'`)).toBeNull();
    expect(splitArgs(`SET k 'a b' "x\\ny" "\\x41"`)).toEqual(['SET', 'k', 'a b', 'x\ny', 'A']);
    expect(splitArgs('GET "open')).toBeNull();
    expect(splitArgs('   ')).toEqual([]);
  });
});

describe('encodeCommand', () => {
  test('writes a multibulk frame with byte lengths', () => {
    expect(new TextDecoder().decode(encodeCommand(['SET', 'k', 'é']))).toBe(
      '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n',
    );
  });
});

describe('ReplyDecoder', () => {
  test('waits for complete replies across chunks', () => {
    const d = new ReplyDecoder();
    expect(d.push(bytes('*2\r\n$1\r\na'))).toEqual([]);
    expect(d.push(bytes('\r\n:5\r\n+OK\r\n'))).toEqual([
      {
        kind: 'array',
        items: [
          { kind: 'bulk', value: 'a' },
          { kind: 'integer', value: '5' },
        ],
      },
      { kind: 'simple', value: 'OK' },
    ]);
  });

  test('decodes RESP3 types', () => {
    expect(decodeAll('%1\r\n+a\r\n,1.5\r\n~1\r\n#t\r\n_\r\n=7\r\ntxt:abc\r\n')).toEqual([
      {
        kind: 'map',
        entries: [
          [
            { kind: 'simple', value: 'a' },
            { kind: 'double', value: '1.5' },
          ],
        ],
      },
      { kind: 'set', items: [{ kind: 'boolean', value: true }] },
      { kind: 'null' },
      { kind: 'verbatim', value: 'abc' },
    ]);
    expect(decodeAll('$-1\r\n')).toEqual([{ kind: 'null' }]);
  });
});

describe('formatReply', () => {
  test('prints nested arrays and maps like redis-cli', () => {
    const [reply] = decodeAll('*3\r\n$1\r\na\r\n*2\r\n:1\r\n:2\r\n*0\r\n');
    expect(reply && formatReply(reply)).toEqual([
      '1) "a"',
      '2) 1) (integer) 1',
      '   2) (integer) 2',
      '3) (empty array)',
    ]);
    const [map] = decodeAll('%2\r\n$1\r\nf\r\n$1\r\nv\r\n$1\r\ng\r\n$-1\r\n');
    expect(map && formatReply(map)).toEqual(['1# "f" => "v"', '2# "g" => (nil)']);
    expect(formatReply({ kind: 'bulk', value: 'a"b\n' })).toEqual(['"a\\"b\\n"']);
    expect(formatReply({ kind: 'error', value: 'ERR x' })).toEqual(['(error) ERR x']);
  });
});
