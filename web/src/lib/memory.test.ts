import { describe, expect, test } from 'vitest';
import { formatScope, parseScope, radialLayout } from '@/lib/memory';

describe('scopes', () => {
  test('user[/agent[/session]] parses and prints back', () => {
    expect(parseScope('alice')).toEqual({ user: 'alice' });
    expect(parseScope('alice/helper/s1')).toEqual({
      user: 'alice',
      agent: 'helper',
      session: 's1',
    });
    expect(parseScope(' alice / helper ')).toEqual({ user: 'alice', agent: 'helper' });
    expect(parseScope('')).toEqual({ user: '' });
    expect(formatScope({ user: 'alice', agent: 'helper' })).toBe('alice/helper');
    expect(formatScope({ user: '' })).toBe('(tenant-wide)');
  });
});

describe('radialLayout', () => {
  const nodes = [
    { id: 'person:ana', depth: 0 },
    { id: 'org:acme', depth: 1 },
    { id: 'place:lisbon', depth: 1 },
    { id: 'place:portugal', depth: 2 },
  ];

  test('puts the entity in the centre and each depth on its own ring', () => {
    const layout = radialLayout(nodes, 400, 300);
    const at = (id: string) => layout.get(id) ?? { x: NaN, y: NaN };
    expect(at('person:ana')).toEqual({ x: 200, y: 150 });
    const r = (id: string) => Math.hypot(at(id).x - 200, at(id).y - 150);
    expect(r('org:acme')).toBeCloseTo(r('place:lisbon'), 6);
    expect(r('place:portugal')).toBeGreaterThan(r('org:acme'));
    expect(Math.max(...[...layout.values()].map((p) => Math.abs(p.y - 150)))).toBeLessThanOrEqual(
      150,
    );
  });

  test('is deterministic and spreads a ring evenly', () => {
    const a = radialLayout(nodes, 400, 300);
    expect(radialLayout(nodes, 400, 300)).toEqual(a);
    const one = a.get('org:acme');
    const two = a.get('place:lisbon');
    expect(one && two && Math.round(Math.hypot(one.x - two.x, one.y - two.y))).toBeGreaterThan(50);
  });
});
