import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { EntryType, MessageSchema, MessageType, SnapshotRequestSchema } from '@mindlog/proto';

describe('raft.proto', () => {
  test('Message round-trips entries, snapshot meta and 64-bit fields', () => {
    const message = create(MessageSchema, {
      type: MessageType.APPEND,
      from: 1n,
      to: 2n,
      term: 2n ** 64n - 1n,
      logTerm: 3n,
      index: 41n,
      entries: [{ term: 4n, index: 42n, type: EntryType.NORMAL, data: new Uint8Array([1, 2]) }],
      commit: 40n,
      snapshot: {
        index: 9n,
        term: 2n,
        confState: { voters: [1n, 2n], addresses: { '1': 'a:7000' } },
      },
      context: new Uint8Array([7]),
      rangeId: 1n,
      leaseTick: 12n,
    });
    expect(fromBinary(MessageSchema, toBinary(MessageSchema, message))).toEqual(message);
  });

  test('SnapshotRequest carries key/value chunks', () => {
    const chunk = create(SnapshotRequestSchema, {
      pairs: [{ key: new Uint8Array([1]), value: new Uint8Array([2]) }],
    });
    expect(fromBinary(SnapshotRequestSchema, toBinary(SnapshotRequestSchema, chunk))).toEqual(
      chunk,
    );
  });
});
