import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { ChangedRecord, Fields, MergeInput, MergePolicy } from '@mindlog/branching';
import { MERGE_POLICIES, planMerge } from '@mindlog/branching';

const live: Fields = { expired: false, trust: 'normal', validTo: 0n };

const input = (over: Partial<MergeInput> = {}): MergeInput => ({
  branch: 'plan',
  policy: 'raise',
  adds: [],
  records: [],
  edges: [],
  edgeSupport: 20,
  ...over,
});

const contradicting = { id: 'b1', contradicts: [{ with: 'a1', scoreAB: 0.9, scoreBA: 0.2 }] };

describe('merge policies on contradicting facts', () => {
  test.each<[MergePolicy, object]>([
    [
      'raise',
      {
        aborted: false,
        adds: [
          { id: 'b1', quarantine: true },
          { id: 'b2', quarantine: false },
        ],
        conflicts: [{ a: 'a1', b: 'b1', resolved: false }],
        supersede: [],
      },
    ],
    [
      'prefer_branch',
      {
        aborted: false,
        adds: [
          { id: 'b1', quarantine: false },
          { id: 'b2', quarantine: false },
        ],
        conflicts: [{ a: 'a1', b: 'b1', resolved: true }],
        supersede: ['a1'],
      },
    ],
    [
      'prefer_main',
      { aborted: false, adds: [{ id: 'b2', quarantine: false }], rejected: ['b1'], conflicts: [] },
    ],
    ['abort', { aborted: true, adds: [], conflicts: [{ a: 'a1', b: 'b1' }] }],
  ])('%s', (policy, expected) => {
    const plan = planMerge(input({ policy, adds: [contradicting, { id: 'b2', contradicts: [] }] }));
    expect(plan).toMatchObject(expected);
  });

  test('a contradiction with a main fact the branch forgot is no conflict', () => {
    const forgot: ChangedRecord = {
      id: 'a1',
      fork: live,
      main: live,
      mainHlc: 1n,
      branch: { ...live, expired: true },
      branchHlc: 5n,
    };
    const plan = planMerge(input({ adds: [contradicting], records: [forgot] }));
    expect(plan.conflicts).toEqual([]);
    expect(plan.adds).toEqual([{ id: 'b1', quarantine: false }]);
    expect(plan.records).toEqual([{ id: 'a1', fields: { ...live, expired: true } }]);
  });
});

describe('field merges', () => {
  const changed = (
    main: Partial<Fields>,
    mainHlc: bigint,
    branch: Partial<Fields>,
    branchHlc: bigint,
  ) =>
    planMerge(
      input({
        records: [
          {
            id: 'a1',
            fork: live,
            main: { ...live, ...main },
            mainHlc,
            branch: { ...live, ...branch },
            branchHlc,
          },
        ],
      }),
    ).records;

  test('a field only one side changed takes that side', () => {
    expect(changed({}, 1n, { trust: 'verified' }, 2n)).toEqual([
      { id: 'a1', fields: { ...live, trust: 'verified' } },
    ]);
    expect(changed({ trust: 'quarantined' }, 9n, { validTo: 5n }, 2n)).toEqual([
      { id: 'a1', fields: { ...live, trust: 'quarantined', validTo: 5n } },
    ]);
    expect(changed({ trust: 'verified' }, 2n, {}, 3n)).toEqual([]);
  });

  test('a field both sides changed goes to the later write', () => {
    expect(changed({ trust: 'quarantined' }, 3n, { trust: 'verified' }, 4n)[0]?.fields.trust).toBe(
      'verified',
    );
    expect(changed({ trust: 'quarantined' }, 5n, { trust: 'verified' }, 4n)).toEqual([]);
  });
});

describe('edges merge as CRDTs', () => {
  test('weights add up and supporting memories unite, newest kept', () => {
    const plan = planMerge(
      input({
        edgeSupport: 3,
        edges: [
          {
            key: 'person:ana|works_at|org:acme',
            main: { weight: 2, memories: ['01A', '01C'] },
            branch: { weight: 1, memories: ['01B', '01D'] },
          },
        ],
      }),
    );
    expect(plan.edges).toEqual([
      { key: 'person:ana|works_at|org:acme', weight: 3, memories: ['01B', '01C', '01D'] },
    ]);
  });
});

describe('determinism', () => {
  const add = fc.record({
    id: fc.constantFrom('b1', 'b2', 'b3', 'b4'),
    contradicts: fc.array(
      fc.record({
        with: fc.constantFrom('a1', 'a2', 'a3'),
        scoreAB: fc.double({ min: 0, max: 1, noNaN: true }),
        scoreBA: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
      { maxLength: 2 },
    ),
  });

  test('the plan does not depend on the order the leader read things in', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(add, { selector: (a) => a.id, maxLength: 4 }),
        fc.constantFrom(...MERGE_POLICIES),
        (adds, policy) => {
          const a = planMerge(input({ policy, adds }));
          const b = planMerge(input({ policy, adds: [...adds].reverse() }));
          expect(b).toEqual(a);
        },
      ),
    );
  });
});
