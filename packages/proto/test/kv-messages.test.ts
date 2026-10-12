import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { KvBatchSchema, KvHeaderSchema, KvReplySchema, KvType } from '@mindlog/proto';

describe('kv.proto', () => {
  test('KvHeader round-trips with signed list bounds and 64-bit fields', () => {
    const header = create(KvHeaderSchema, {
      type: KvType.LIST,
      generation: 3n,
      count: 2n,
      expireAtMs: 1_760_000_000_000n,
      version: 2n ** 64n - 1n,
      listHead: -5n,
      listTail: -3n,
    });
    const decoded = fromBinary(KvHeaderSchema, toBinary(KvHeaderSchema, header));
    expect(decoded).toEqual(header);
  });

  test('KvReply nests arrays, maps and errors', () => {
    const reply = create(KvReplySchema, {
      kind: {
        case: 'array',
        value: {
          items: [
            { kind: { case: 'integer', value: -1n } },
            { kind: { case: 'null', value: {} } },
            { kind: { case: 'error', value: { code: 'WRONG_TYPE', message: 'nope' } } },
            {
              kind: {
                case: 'map',
                value: {
                  entries: [
                    {
                      key: { kind: { case: 'bulk', value: new Uint8Array([0x66]) } },
                      value: { kind: { case: 'double', value: 1.5 } },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    });
    expect(fromBinary(KvReplySchema, toBinary(KvReplySchema, reply))).toEqual(reply);
  });

  test('KvBatch carries writes as raw argv and watched versions', () => {
    const utf8 = new TextEncoder();
    const batch = create(KvBatchSchema, {
      writes: [{ argv: ['SET', 'k', 'v'].map((a) => utf8.encode(a)) }],
      watches: [{ key: utf8.encode('k'), version: 7n }],
    });
    const decoded = fromBinary(KvBatchSchema, toBinary(KvBatchSchema, batch));
    expect(decoded.writes[0]?.argv.map((a) => new TextDecoder().decode(a))).toEqual([
      'SET',
      'k',
      'v',
    ]);
    expect(decoded.watches[0]?.version).toBe(7n);
  });
});
