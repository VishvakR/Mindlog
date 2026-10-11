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
