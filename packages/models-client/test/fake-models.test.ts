import { describe, expect, test } from 'vitest';
import { FakeModels } from '@mindlog/models-client';
import { describeModelsContract } from './models-contract.js';

describeModelsContract('FakeModels', () => Promise.resolve(new FakeModels()));

describe('FakeModels', () => {
  test('is deterministic', async () => {
    const [a, b] = await Promise.all([
      new FakeModels().embed(['same text'], 'passage'),
      new FakeModels().embed(['same text'], 'passage'),
    ]);
    expect(a.ok && b.ok && [...(a.value.vectors[0] ?? [])]).toEqual(
      b.ok && [...(b.value.vectors[0] ?? [])],
    );
  });

  test('a stopped fake answers UNAVAILABLE', async () => {
    const models = new FakeModels();
    models.down = true;
    const r = await models.embed(['x'], 'query');
    expect(!r.ok && r.error.code).toBe('UNAVAILABLE');
  });
});
