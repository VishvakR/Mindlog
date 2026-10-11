import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { CommandSchema, ErrorDetailSchema } from '@mindlog/proto';

describe('Command envelope', () => {
  test('round-trips through binary with a bigint HLC', () => {
    const cmd = create(CommandSchema, {
      requestId: new Uint8Array([1, 2, 3]),
      principal: 'agent:planner',
      hlc: (1_760_000_000_000n << 16n) | 7n,
      branch: 'main',
    });

    const decoded = fromBinary(CommandSchema, toBinary(CommandSchema, cmd));

    expect(decoded.hlc).toBe(cmd.hlc);
    expect(typeof decoded.hlc).toBe('bigint');
    expect(decoded.principal).toBe('agent:planner');
    expect(Array.from(decoded.requestId)).toEqual([1, 2, 3]);
  });

  test('keeps the full uint64 range of the HLC', () => {
    const max = 2n ** 64n - 1n;
    const decoded = fromBinary(
      CommandSchema,
      toBinary(CommandSchema, create(CommandSchema, { hlc: max })),
    );
    expect(decoded.hlc).toBe(max);
  });

  test('reserves body field numbers 10-99', () => {
    const reserved = CommandSchema.fields.filter((f) => f.number >= 10 && f.number <= 99);
    expect(reserved).toEqual([]);
  });
});

describe('wire compatibility with Python', () => {
  // Same Command as python/mindlog_proto/tests/test_commands.py (ADR-0004).
  const GOLDEN_HEX =
    '0a 03 01 02 03 12 0d 61 67 65 6e 74 3a 70 6c 61 6e 6e 65 72 18 87 80 80 80 cc 85 f2 cc 01 22 04 6d 61 69 6e';

  test('serializes to the shared golden bytes', () => {
    const cmd = create(CommandSchema, {
      requestId: new Uint8Array([1, 2, 3]),
      principal: 'agent:planner',
      hlc: (1_760_000_000_000n << 16n) | 7n,
      branch: 'main',
    });
    const hex = Array.from(toBinary(CommandSchema, cmd), (b) => b.toString(16).padStart(2, '0'));
    expect(hex.join(' ')).toBe(GOLDEN_HEX);
  });
});

describe('ErrorDetail', () => {
  test('carries field-level details', () => {
    const detail = create(ErrorDetailSchema, {
      code: 'INVALID_ARGUMENT',
      message: 'bad input',
      fields: { 'scope.tenant': 'required' },
      retryable: false,
    });
    const decoded = fromBinary(ErrorDetailSchema, toBinary(ErrorDetailSchema, detail));
    expect(decoded.fields).toEqual({ 'scope.tenant': 'required' });
  });
});
