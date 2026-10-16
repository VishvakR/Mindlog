import { describe, expect, test } from 'vitest';
import {
  clusterAddLearnerCommand,
  clusterInfoCommand,
  clusterPromoteCommand,
  clusterRemoveCommand,
  clusterTransferCommand,
} from '@mindlog/adapter-resp';
import { openClient, respServer } from '../support/resp-node.js';

const server = () =>
  respServer({
    handlers: [
      clusterInfoCommand,
      clusterAddLearnerCommand,
      clusterPromoteCommand,
      clusterRemoveCommand,
      clusterTransferCommand,
    ],
  });

describe('CLUSTER.* (ADR-0006)', () => {
  test('CLUSTER.INFO reports the single-voter range this node leads', async () => {
    const c = openClient(await server());
    const info = await c.send(['CLUSTER.INFO']);
    // RESP2: the map is a flat array of 7 pairs.
    expect(info).toMatch(/^\*14\r\n/);
    expect(info).toContain('$4\r\nrole\r\n$6\r\nleader\r\n');
    expect(info).toContain('$6\r\nleader\r\n:1\r\n');
    expect(info).toContain('$6\r\nvoters\r\n*1\r\n:1\r\n');
  });

  test('membership changes are validated and applied', async () => {
    const c = openClient(await server());
    expect(await c.send(['CLUSTER.ADDLEARNER', '0', 'x:1'])).toMatch(/^-ERR node id/);
    expect(await c.send(['CLUSTER.ADDLEARNER', '2', ' '])).toMatch(/^-ERR address is required/);
    expect(await c.send(['CLUSTER.ADDLEARNER', '2', 'n2:7000'])).toContain(':2\r\n');
    expect(await c.send(['CLUSTER.PROMOTE', '1'])).toMatch(/already a voter/);
    expect(await c.send(['CLUSTER.REMOVE', '2'])).not.toMatch(/^-/);
    expect(await c.send(['CLUSTER.REMOVE', '1'])).toMatch(/last voter/);
  });

  test('CLUSTER.TRANSFER to itself is a no-op; to a stranger is an error', async () => {
    const c = openClient(await server());
    expect(await c.send(['CLUSTER.TRANSFER', '1'])).toBe('+OK\r\n');
    expect(await c.send(['CLUSTER.TRANSFER', '9'])).toMatch(/^-ERR node 9 is not a voter/);
    expect(await c.send(['CLUSTER.TRANSFER', 'abc'])).toMatch(/^-ERR node id/);
  });
});
