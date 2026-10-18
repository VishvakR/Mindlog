import { describe, expect, test } from 'vitest';
import { headerKey } from '@mindlog/kv';
import { describeKey } from '@mindlog/services';

describe('describeKey', () => {
  test('a stored key shows as tenant/key; other bytes are escaped', () => {
    expect(describeKey(headerKey('default', new TextEncoder().encode('order:118')))).toBe(
      'default/order:118',
    );
    expect(describeKey(new Uint8Array([0x61, 0x00, 0x62]))).toBe('a\\x00b');
    expect(describeKey(new Uint8Array())).toBe('');
  });
});
