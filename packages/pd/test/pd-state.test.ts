import type { MessageInitShape } from '@bufbuild/protobuf';
import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';

import type { Command } from '@mindlog/proto';
import { CommandSchema, NodeState, RangeDescriptorSchema, RangeEpochSchema } from '@mindlog/proto';
import { FIRST_ALLOCATED_ID, PdView, decodeU64 } from '@mindlog/pd';
import { pdNode } from './support/pd-node.js';

type Body = NonNullable<MessageInitShape<typeof CommandSchema>['body']>;
let seq = 0;
const command = (body: Body): Command =>
  create(CommandSchema, { requestId: new TextEncoder().encode(`pd-${seq++}`), body });

const range = (id: bigint, start: string, end: string, version = 0n, conf = 0n) =>
  create(RangeDescriptorSchema, {
    rangeId: id,
    startKey: new TextEncoder().encode(start),
    endKey: new TextEncoder().encode(end),
    epoch: create(RangeEpochSchema, { version, confVersion: conf }),
  });

async function result(node: Awaited<ReturnType<typeof pdNode>>, body: Body) {
  const proposed = await node.replica.propose(command(body));
  if (!proposed.ok) throw new Error(proposed.error.message);
  const outcome = proposed.value.result.outcome;
  if (outcome.case !== 'kv' || outcome.value.kind.case !== 'integer')
    throw new Error('not an integer');
  return outcome.value.kind.value;
}

describe('PD state machine', () => {
  test('hands out consecutive ids starting at the allocated base, never twice', async () => {
    const node = await pdNode();
    expect(await result(node, { case: 'pdAllocIds', value: { count: 3 } })).toBe(
      FIRST_ALLOCATED_ID,
    );
    expect(await result(node, { case: 'pdAllocIds', value: { count: 1 } })).toBe(
      FIRST_ALLOCATED_ID + 3n,
    );
    const refused = await node.replica.propose(
      command({ case: 'pdAllocIds', value: { count: 0 } }),
    );
    expect(refused.ok && refused.value.result.outcome.case).toBe('error');
  });

  test('keeps the directory ordered, answers key lookups, and ignores stale epochs', async () => {
    const node = await pdNode();
    const view = new PdView(node.store);
    const put = (r: ReturnType<typeof range>) =>
      result(node, { case: 'pdPutRange', value: { range: r } });
    expect(await put(range(1n, '', 'm'))).toBe(1n);
    expect(await put(range(2n, 'm', ''))).toBe(1n);
    expect((await view.rangeFor(new TextEncoder().encode('a')))?.rangeId).toBe(1n);
    expect((await view.rangeFor(new TextEncoder().encode('l\xff')))?.rangeId).toBe(1n);
    expect((await view.rangeFor(new TextEncoder().encode('m')))?.rangeId).toBe(2n);
    expect((await view.rangeFor(new TextEncoder().encode('zzz')))?.rangeId).toBe(2n);

    // Range 1 splits at "g": the newer epoch replaces it, an older one is ignored.
    expect(await put(range(1n, '', 'g', 1n))).toBe(1n);
    expect(await put(range(1n, '', 'm', 0n))).toBe(0n);
    expect(await put(range(3n, 'g', 'm', 1n))).toBe(1n);
    expect((await view.rangeFor(new TextEncoder().encode('h')))?.rangeId).toBe(3n);
    expect((await view.ranges()).map((r) => r.rangeId)).toEqual([1n, 3n, 2n]);
    // A membership change of the same version is newer by conf version.
    expect(await put(range(3n, 'g', 'm', 1n, 1n))).toBe(1n);
    expect(await put(range(3n, 'g', 'm', 1n, 1n))).toBe(0n);

    await result(node, { case: 'pdRemoveRange', value: { rangeId: 3n } });
    expect(await view.rangeFor(new TextEncoder().encode('h'))).toBeUndefined();
  });

  test('stores nodes, a monotonic TSO bound and a monotonic cluster version', async () => {
    const node = await pdNode();
    const view = new PdView(node.store);
    await result(node, {
      case: 'pdPutNode',
      value: {
        node: {
          nodeId: 7n,
          address: 'n7:7000',
          zone: 'a',
          state: NodeState.LIVE,
          binaryVersion: 4,
          labels: [],
        },
      },
    });
    expect((await view.nodes()).map((n) => [n.nodeId, n.address])).toEqual([[7n, 'n7:7000']]);
    expect(await result(node, { case: 'pdSetTso', value: { max: 500n } })).toBe(500n);
    expect(await result(node, { case: 'pdSetTso', value: { max: 100n } })).toBe(500n);
    expect(await view.tsoBound()).toBe(500n);
    await result(node, { case: 'pdSetVersion', value: { version: 4 } });
    await result(node, { case: 'pdSetVersion', value: { version: 3 } });
    expect(await view.clusterVersion()).toBe(4);
    expect(decodeU64(undefined, 9n)).toBe(9n);
  });
});
