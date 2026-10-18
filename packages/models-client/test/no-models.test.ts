import { describe, expect, test } from 'vitest';
import { NoModels } from '@mindlog/models-client';

describe('NoModels', () => {
  test('every capability is unavailable, so memory runs degraded', async () => {
    const models = new NoModels();
    expect(models.available()).toBe(false);
    const r = await models.embed(['x'], 'query');
    expect(!r.ok && r.error.code).toBe('UNAVAILABLE');
    const h = await models.health();
    expect(h.ok && h.value.ready).toBe(false);
  });
});
