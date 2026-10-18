import { describe, expect, test } from 'vitest';
import { fromRequest, toRequest } from '@mindlog/router';
import type { RangeCall } from '@mindlog/services';

const caller = { tenant: 'acme', principal: 'agent:1' };
const enc = new TextEncoder();

describe('forward codec', () => {
  test.each<RangeCall>([
    {
      kind: 'command',
      argv: [enc.encode('SET'), enc.encode('k'), enc.encode('v')],
      requestId: enc.encode('r1'),
    },
    { kind: 'watch', keys: [enc.encode('k')] },
    { kind: 'memory', op: 'remember', json: '{"content":"hi"}', requestId: enc.encode('r2') },
  ])('round-trips a $kind call', (call) => {
    const back = fromRequest(toRequest(7n, caller, call, 5n, 'node:7000'));
    expect(back).toEqual({ rangeId: 7n, caller, call });
  });
});
