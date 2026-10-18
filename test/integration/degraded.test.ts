import { Redis } from 'ioredis';
import { afterAll, describe, expect, test } from 'vitest';
import type { ServedModels } from '@mindlog/models-client';
import { FakeModels, serveModels } from '@mindlog/models-client';
import { startTestNode } from '../support/node.js';

/**
 * Phase 5 gate: degraded mode (PLAN 21). The model service stops; remember
 * still stores the raw text with an enrichment job and recall still answers
 * from keywords; once the service is back, the job derives the facts.
 */
type Flat = Array<string | number | null | Flat>;
const asMap = (reply: unknown): Record<string, unknown> => {
  const flat = reply as Flat;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let models: ServedModels | undefined;
let server: Awaited<ReturnType<typeof startTestNode>> | undefined;
let redis: Redis | undefined;

afterAll(async () => {
  redis?.disconnect();
  await server?.stop();
  await models?.close();
});

describe('degraded mode', () => {
  test('memory keeps working without the model service and catches up after', async () => {
    models = await serveModels(new FakeModels());
    const port = Number(models.address.split(':')[1]);
    server = await startTestNode({
      models: { endpoint: models.address, timeoutMs: 300, breakerFailures: 1, breakerOpenMs: 300 },
    });
    redis = new Redis({ port: server.port, host: '127.0.0.1', maxRetriesPerRequest: 0 });

    const healthy = asMap(await redis.call('MEM.ADD', 'alice', 'I prefer dark roast coffee.'));
    expect(healthy.degraded).toBe(0);

    await models.close();
    const degraded = asMap(await redis.call('MEM.ADD', 'alice', 'My sister Ana lives in Lisbon.'));
    expect(degraded.degraded).toBe(1);
    expect(typeof degraded.job).toBe('string');
    const found = (await redis.call('MEM.SEARCH', 'alice', 'Lisbon')) as Flat[];
    expect(found.map((i) => [asMap(i).kind, asMap(i).text])).toEqual([
      ['episodic', 'My sister Ana lives in Lisbon.'],
    ]);

    models = await serveModels(new FakeModels(), { port });
    let kinds: unknown[] = [];
    for (let tries = 0; tries < 60 && !kinds.includes('semantic'); tries++) {
      await sleep(250);
      const items = (await redis.call('MEM.SEARCH', 'alice', 'Lisbon')) as Flat[];
      kinds = items
        .map((i) => asMap(i))
        .filter((m) => String(m.text).includes('Lisbon'))
        .map((m) => m.kind);
    }
    expect(kinds.sort()).toEqual(['episodic', 'semantic']);
  }, 30_000);
});
