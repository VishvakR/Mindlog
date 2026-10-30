import { replies } from '@mindlog/kv';
import type { BranchView } from '@mindlog/memory';
import type { KvReply } from '@mindlog/proto';
import type { ConnectionCommand } from '../connection-command.js';
import {
  answer,
  caller,
  decoder,
  isReply,
  memoryReply,
  options,
  scopeOf,
  text,
  withMemory,
} from './memory.js';

// Memory branches over RESP (PLAN 13.1, ADR-0013).

const target = (argv: readonly Uint8Array[]) => ({
  scope: scopeOf(argv[1]),
  name: decoder.decode(argv[2]),
});

function branchReply(b: BranchView): KvReply {
  return replies.map([
    [text('name'), text(b.name)],
    [text('status'), text(b.status)],
    [text('fork_index'), text(b.forkIndex)],
    [text('fork_at'), replies.integer(b.forkAtMs)],
    [text('created_by'), text(b.createdBy)],
    [text('writes'), replies.integer(b.writes)],
  ]);
}

/** `MEM.BRANCH <scope> <name>`: a branch that reads main as of now. */
export const memBranchCommand: ConnectionCommand = {
  name: 'MEM.BRANCH',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) =>
      answer(await memory.createBranch(caller(ctx), target(argv)), () => replies.ok()),
    ),
};

/** `MEM.BRANCHES <scope>`: the scope's branches, open and closed. */
export const memBranchesCommand: ConnectionCommand = {
  name: 'MEM.BRANCHES',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) =>
      answer(await memory.branches(caller(ctx), { scope: scopeOf(argv[1]) }), (list) =>
        replies.array(list.map(branchReply)),
      ),
    ),
};

/** `MEM.DIFF <scope> <name>`: what the branch added, forgot and changed. */
export const memDiffCommand: ConnectionCommand = {
  name: 'MEM.DIFF',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) =>
      answer(await memory.diffBranch(caller(ctx), target(argv)), (d) =>
        replies.map([
          [text('added'), replies.array(d.added.map(memoryReply))],
          [text('forgotten'), replies.array(d.forgotten.map(memoryReply))],
          [text('changed'), replies.array(d.changed.map(memoryReply))],
        ]),
      ),
    ),
};

/** `MEM.MERGE <scope> <name> [POLICY abort|raise|prefer_branch|prefer_main]`. */
export const memMergeCommand: ConnectionCommand = {
  name: 'MEM.MERGE',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const o = options(argv, 3, ['POLICY'], []);
      if (isReply(o)) return o;
      return answer(
        await memory.mergeBranch(caller(ctx), {
          ...target(argv),
          ...(typeof o.POLICY === 'string' ? { policy: o.POLICY.toLowerCase() as never } : {}),
        }),
        (r) =>
          replies.map([
            [text('merged'), replies.integer(r.merged ? 1 : 0)],
            [text('added'), replies.array(r.added.map(text))],
            [text('rejected'), replies.array(r.rejected.map(text))],
            [
              text('conflicts'),
              replies.array(
                r.conflicts.map((c) =>
                  replies.map([
                    [text('a'), text(c.a)],
                    [text('b'), text(c.b)],
                    [text('resolved'), replies.integer(c.resolved ? 1 : 0)],
                  ]),
                ),
              ),
            ],
          ]),
      );
    }),
};

/** `MEM.DROP <scope> <name>`: closes the branch and deletes its memories. */
export const memDropCommand: ConnectionCommand = {
  name: 'MEM.DROP',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) =>
      answer(await memory.dropBranch(caller(ctx), target(argv)), () => replies.ok()),
    ),
};
