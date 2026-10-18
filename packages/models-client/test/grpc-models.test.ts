import { afterAll, describe, expect, test } from 'vitest';
import { GrpcModels } from '@mindlog/models-client';
import { describeModelsContract } from './models-contract.js';
import { startFakeModelServer } from './support/fake-model-server.js';

const servers: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

describeModelsContract('GrpcModels', async () => {
  const server = await startFakeModelServer();
  servers.push(server);
  return new GrpcModels({ address: server.address, timeoutMs: 2000 });
});

describe('GrpcModels errors', () => {
  test('a stopped service is UNAVAILABLE', async () => {
    const server = await startFakeModelServer();
    await server.close();
    const r = await new GrpcModels({ address: server.address, timeoutMs: 500 }).embed(
      ['x'],
      'query',
    );
    expect(!r.ok && r.error.code).toBe('UNAVAILABLE');
  });

  test('a full queue is BUSY and a missing model is UNAVAILABLE', async () => {
    const server = await startFakeModelServer({ embed: 'busy', ner: 'missing' });
    servers.push(server);
    const models = new GrpcModels({ address: server.address, timeoutMs: 2000 });
    const busy = await models.embed(['x'], 'query');
    expect(!busy.ok && busy.error.code).toBe('BUSY');
    const missing = await models.recognize(['x'], ['person']);
    expect(!missing.ok && missing.error.code).toBe('UNAVAILABLE');
  });

  test('a slow answer is DEADLINE_EXCEEDED', async () => {
    const server = await startFakeModelServer({ embed: 'slow' });
    servers.push(server);
    const r = await new GrpcModels({ address: server.address, timeoutMs: 50 }).embed(
      ['x'],
      'query',
    );
    expect(!r.ok && r.error.code).toBe('DEADLINE_EXCEEDED');
  });
});
