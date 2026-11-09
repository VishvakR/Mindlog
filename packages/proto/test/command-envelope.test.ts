import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { CommandResultSchema, CommandSchema, ErrorDetailSchema } from '@mindlog/proto';

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

  test('uses body numbers 10-13, 20-25 (memory), 30-32 (branches), 40-41 (cache), 50-51 (collections), 60-63 (transactions), 71-72 (jobs), 80-82 (ranges), 90-96 (placement driver), 100-104 (audit, tenants) and keeps the rest of 14-99 free', () => {
    const bodyNumbers = CommandSchema.fields.map((f) => f.number).filter((n) => n >= 10);
    expect(bodyNumbers).toEqual([
      10, 11, 12, 13, 20, 21, 22, 23, 24, 25, 30, 31, 32, 40, 41, 50, 51, 60, 61, 62, 63, 71, 72,
      80, 81, 82, 90, 91, 92, 93, 94, 95, 96, 100, 101, 102, 104,
    ]);
  });

  test('carries a tenant and a KvWrite body', () => {
    const utf8 = new TextEncoder();
    const cmd = create(CommandSchema, {
      tenant: 'acme',
      body: { case: 'kvWrite', value: { argv: ['INCR', 'n'].map((a) => utf8.encode(a)) } },
    });
    const decoded = fromBinary(CommandSchema, toBinary(CommandSchema, cmd));
    expect(decoded.tenant).toBe('acme');
    expect(decoded.body.case).toBe('kvWrite');
  });

  test('CommandResult holds either a KV reply or an error', () => {
    const okResult = create(CommandResultSchema, {
      outcome: { case: 'kv', value: { kind: { case: 'simple', value: 'OK' } } },
    });
    const errResult = create(CommandResultSchema, {
      outcome: { case: 'error', value: { code: 'INVALID_ARGUMENT', message: 'bad' } },
    });
    for (const r of [okResult, errResult]) {
      expect(fromBinary(CommandResultSchema, toBinary(CommandResultSchema, r))).toEqual(r);
    }
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
