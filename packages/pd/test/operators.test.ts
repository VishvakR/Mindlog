import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { DEFAULT_PD_CONFIG, OperatorController } from '@mindlog/pd';
import type { PlannedOperator } from '@mindlog/pd';
import {
  NodeInfoSchema,
  RangeEpochSchema,
  ReplicaDescriptorSchema,
  ReplicaRole,
  StepKind,
} from '@mindlog/proto';
import { range } from './support/views.js';

const nodes = new Map(
  [1, 2, 3, 4].map((n) => [
    BigInt(n),
    create(NodeInfoSchema, { nodeId: BigInt(n), address: `n${n}:7000` }),
  ]),
);

function controller(next = 5000n, config = DEFAULT_PD_CONFIG) {
  let id = next;
  return new OperatorController(config, (count) => {
    const first = id;
    id += BigInt(count);
    return Promise.resolve(first);
  });
}

const move: PlannedOperator = {
  rangeId: 1n,
  explanation: 'move',
  steps: [
    { kind: 'add-learner', nodeId: 4n },
    { kind: 'promote', replicaId: 0n },
    { kind: 'remove-voter', replicaId: 103n },
  ],
};

/** The range as the leader reports it after some steps. */
function at(replicas: Array<[number, ReplicaRole]>, leader = 101, version = 0n) {
  const base = range(1, [1, 2, 3]);
  return {
    ...base,
    leaderReplicaId: BigInt(leader),
    range: {
      ...base.range,
      epoch: create(RangeEpochSchema, { version }),
      replicas: replicas.map(([id, role]) =>
        create(ReplicaDescriptorSchema, { nodeId: BigInt(id % 100), replicaId: BigInt(id), role }),
      ),
    },
  };
}

const V = ReplicaRole.VOTER;
const L = ReplicaRole.LEARNER;

describe('OperatorController', () => {
  test('allocates ids for the new replica, fills addresses, and runs one step at a time', async () => {
    const c = controller();
    const rv = range(1, [1, 2, 3]);
    const op = await c.add(move, 'repair', rv, 0, nodes);
    expect(op?.id).toBe(5000n);
    expect(op?.steps.map((s) => s.kind)).toEqual([
      StepKind.ADD_LEARNER,
      StepKind.PROMOTE,
      StepKind.REMOVE_VOTER,
    ]);
    expect(op?.steps[0]).toMatchObject({ replicaId: 5001n, nodeId: 4n, address: 'n4:7000' });
    expect(op?.steps[1]?.replicaId).toBe(5001n);

    // Nothing changed yet: the first step is handed out again (idempotent).
    expect(c.onHeartbeat(rv, 1)?.step).toBe(0);
    // The learner exists: next step is promote.
    const withLearner = at([
      [101, V],
      [102, V],
      [103, V],
      [5001, L],
    ]);
    expect(c.onHeartbeat(withLearner, 2)?.step).toBe(1);
    // Promoted: remove the old voter.
    const promoted = at([
      [101, V],
      [102, V],
      [103, V],
      [5001, V],
    ]);
    expect(c.onHeartbeat(promoted, 3)?.step).toBe(2);
    // Gone: the operator is done and reported.
    const done = at([
      [101, V],
      [102, V],
      [5001, V],
    ]);
    expect(c.onHeartbeat(done, 4)).toBeUndefined();
    expect(c.busy().size).toBe(0);
    expect(c.takeFinished().map((o) => o.status)).toEqual(['done']);
  });

  test('skips several finished steps in one heartbeat', async () => {
    const c = controller();
    await c.add(move, 'repair', range(1, [1, 2, 3]), 0, nodes);
    const promoted = at([
      [101, V],
      [102, V],
      [103, V],
      [5001, V],
    ]);
    expect(c.onHeartbeat(promoted, 1)?.step).toBe(2);
  });

  test('refuses a second operator on a range and respects the global limit', async () => {
    const c = controller(5000n, { ...DEFAULT_PD_CONFIG, maxOperators: 1 });
    expect(await c.add(move, 'repair', range(1, [1, 2, 3]), 0, nodes)).toBeDefined();
    expect(await c.add(move, 'repair', range(1, [1, 2, 3]), 0, nodes)).toBeUndefined();
    expect(
      await c.add({ ...move, rangeId: 2n }, 'repair', range(2, [1, 2, 3]), 0, nodes),
    ).toBeUndefined();
  });

  test('a split is done once the range epoch grows; a transfer once the leader changes', async () => {
    const c = controller();
    const split = {
      rangeId: 1n,
      explanation: 's',
      steps: [{ kind: 'split', targetRange: 0n }],
    } as const;
    const op = await c.add(split, 'split', range(1, [1, 2, 3]), 0, nodes);
    expect(op?.steps[0]?.newRangeId).toBe(5001n);
    expect(c.onHeartbeat(at([[101, V]], 101, 0n), 1)?.step).toBe(0);
    expect(c.onHeartbeat(at([[101, V]], 101, 1n), 2)).toBeUndefined();

    const transfer = {
      rangeId: 1n,
      explanation: 't',
      steps: [{ kind: 'transfer-leader', replicaId: 102n }],
    } as const;
    await c.add(transfer, 'leader-balance', range(1, [1, 2, 3]), 0, nodes);
    expect(
      c.onHeartbeat(
        at(
          [
            [101, V],
            [102, V],
          ],
          101,
        ),
        3,
      )?.step,
    ).toBe(0);
    expect(
      c.onHeartbeat(
        at(
          [
            [101, V],
            [102, V],
          ],
          102,
        ),
        4,
      ),
    ).toBeUndefined();
  });

  test('times out slow operators and cancels those of vanished ranges', async () => {
    const c = controller(5000n, { ...DEFAULT_PD_CONFIG, operatorTimeoutMs: 1000 });
    await c.add(move, 'repair', range(1, [1, 2, 3]), 0, nodes);
    expect(c.onHeartbeat(range(1, [1, 2, 3]), 2000)).toBeUndefined();
    expect(c.takeFinished().map((o) => o.status)).toEqual(['timeout']);

    await c.add(
      { rangeId: 7n, explanation: 'x', steps: [{ kind: 'merge', targetRange: 6n }] },
      'merge',
      range(7, [1]),
      0,
      nodes,
    );
    await c.add({ ...move, rangeId: 8n }, 'repair', range(8, [1, 2, 3]), 0, nodes);
    c.sweep(new Set([8n]), 10);
    expect(c.takeFinished().map((o) => [o.rangeId, o.status])).toEqual([[7n, 'done']]);
  });
});
