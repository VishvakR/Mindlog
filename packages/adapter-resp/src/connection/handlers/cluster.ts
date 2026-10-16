import type { MindlogError, Result } from '@mindlog/core';
import { parseInteger, replies } from '@mindlog/kv';
import type { ConfState, KvReply } from '@mindlog/proto';
import type { ClusterService } from '@mindlog/services';
import type { ConnectionCommand, ConnectionContext } from '../connection-command.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = (value: string): KvReply => replies.bulk(encoder.encode(value));
const int = (value: bigint): KvReply => replies.integer(value);

function membership(cs: ConfState): KvReply {
  return replies.map([
    [text('voters'), replies.array(cs.voters.map(int))],
    [text('learners'), replies.array(cs.learners.map(int))],
    [
      text('addresses'),
      replies.map(Object.entries(cs.addresses).map(([id, address]) => [text(id), text(address)])),
    ],
  ]);
}

function withCluster(
  ctx: ConnectionContext,
  run: (cluster: ClusterService) => KvReply | Promise<KvReply>,
): KvReply | Promise<KvReply> {
  const cluster = ctx.server.cluster;
  return cluster
    ? run(cluster)
    : replies.error('UNIMPLEMENTED', 'cluster commands are not available');
}

function nodeId(arg: Uint8Array | undefined): bigint | undefined {
  const id = arg ? parseInteger(arg) : undefined;
  return id !== undefined && id >= 1n ? id : undefined;
}

const badId = (): KvReply =>
  replies.error('INVALID_ARGUMENT', 'node id must be a positive integer');

const reply = (result: Result<ConfState, MindlogError>): KvReply =>
  result.ok ? membership(result.value) : replies.error(result.error.code, result.error.message);

/** `CLUSTER.INFO`: role, term, leader, indexes and membership of this node's range. */
export const clusterInfoCommand: ConnectionCommand = {
  name: 'CLUSTER.INFO',
  execute: (ctx) =>
    withCluster(ctx, (cluster) => {
      const s = cluster.info();
      return replies.map([
        [text('id'), int(s.id)],
        [text('role'), text(s.role)],
        [text('term'), int(s.term)],
        [text('leader'), int(s.lead)],
        [text('commit_index'), int(s.commit)],
        [text('applied_index'), int(s.applied)],
        [text('membership'), membership(s.confState)],
      ]);
    }),
};

/** `CLUSTER.ADDLEARNER <id> <address>` (ADR-0006). */
export const clusterAddLearnerCommand: ConnectionCommand = {
  name: 'CLUSTER.ADDLEARNER',
  execute: (ctx, argv) =>
    withCluster(ctx, async (cluster) => {
      const id = nodeId(argv[1]);
      return id === undefined
        ? badId()
        : reply(await cluster.addLearner(id, decoder.decode(argv[2])));
    }),
};

/** `CLUSTER.PROMOTE <id>`: learner → voter. */
export const clusterPromoteCommand: ConnectionCommand = {
  name: 'CLUSTER.PROMOTE',
  execute: (ctx, argv) =>
    withCluster(ctx, async (cluster) => {
      const id = nodeId(argv[1]);
      return id === undefined ? badId() : reply(await cluster.promote(id));
    }),
};

/** `CLUSTER.REMOVE <id>`. */
export const clusterRemoveCommand: ConnectionCommand = {
  name: 'CLUSTER.REMOVE',
  execute: (ctx, argv) =>
    withCluster(ctx, async (cluster) => {
      const id = nodeId(argv[1]);
      return id === undefined ? badId() : reply(await cluster.remove(id));
    }),
};

/** `CLUSTER.TRANSFER <id>`: hand leadership to a caught-up voter. */
export const clusterTransferCommand: ConnectionCommand = {
  name: 'CLUSTER.TRANSFER',
  execute: (ctx, argv) =>
    withCluster(ctx, (cluster) => {
      const id = nodeId(argv[1]);
      if (id === undefined) return badId();
      const result = cluster.transfer(id);
      return result.ok ? replies.ok() : replies.error(result.error.code, result.error.message);
    }),
};
