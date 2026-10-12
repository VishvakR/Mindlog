import { describe, expect, test } from 'vitest';
import { DEFAULT_LIMITS, quitCommand } from '@mindlog/adapter-resp';
import { TEST_LIMITS, frame, openClient, respServer } from '../support/resp-node.js';

describe('connection limits', () => {
  test('a client whose unsent replies exceed the output limit is disconnected', async () => {
    const fixture = await respServer();
    const c = openClient(fixture, { ...TEST_LIMITS, outputBufferBytes: 1000 });
    await c.send(['SET', 'big', 'x'.repeat(600)]);
    c.transport.stalled = true;
    c.transport.pendingBytes = 500;
    await c.send(['GET', 'big']);
    expect(c.isClosed()).toBe(true);
    expect(c.transport.closeReason).toBe('output-limit');
    expect(
      fixture.logger.entries.some((e) => e.message.startsWith('client output buffer limit')),
    ).toBe(true);
    expect(fixture.server.clients.size).toBe(0);
  });

  test('reading pauses while too many commands wait, and resumes when drained', async () => {
    const c = openClient(await respServer(), { ...TEST_LIMITS, maxPipeline: 2 });
    const pipeline = Buffer.concat(
      Array.from({ length: 5 }, (_, i) => frame(['INCR', `k${String(i)}`])),
    );
    c.connection.receive(pipeline);
    expect(c.transport.paused).toBe(true);
    await c.connection.idle();
    expect(c.transport.paused).toBe(false);
    expect(c.transport.pauses).toBe(1);
    expect(Buffer.concat(c.writes).toString()).toBe(':1\r\n'.repeat(5));
  });

  test('oversized requests are protocol errors under the configured parser limits', async () => {
    const c = openClient(await respServer(), {
      ...TEST_LIMITS,
      parser: { ...DEFAULT_LIMITS, maxBulkBytes: 8 },
    });
    expect(await c.send(['SET', 'k', 'x'.repeat(9)])).toBe(
      '-ERR Protocol error: invalid bulk length\r\n',
    );
    expect(c.transport.closeReason).toBe('protocol-error');
  });

  test('close reasons: QUIT and server-initiated', async () => {
    const fixture = await respServer({ handlers: [quitCommand] });
    const a = openClient(fixture);
    await a.send(['QUIT']);
    expect(a.transport.closeReason).toBe('quit');
    const b = openClient(fixture);
    b.connection.close();
    expect(b.transport.closeReason).toBe('server');
  });
});
