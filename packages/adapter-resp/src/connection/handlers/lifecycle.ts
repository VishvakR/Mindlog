import { replies } from '@mindlog/kv';
import type { JobView } from '@mindlog/memory';
import type { KvReply } from '@mindlog/proto';
import type { ConnectionCommand } from '../connection-command.js';
import {
  answer,
  caller,
  decoder,
  flag,
  integerOption,
  isReply,
  options,
  scopeOf,
  text,
  withMemory,
} from './memory.js';

// Memory lifecycle over RESP (ADR-0033, PLAN 13.7, 13.11).

const pinCommand = (name: 'MEM.PIN' | 'MEM.UNPIN', pinned: boolean): ConnectionCommand => ({
  name,
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) =>
      answer(
        await memory.pin(caller(ctx), {
          scope: scopeOf(argv[1]),
          ids: argv.slice(2).map((a) => decoder.decode(a)),
          pinned,
        }),
        (r) => replies.integer(r.count),
      ),
    ),
});

/** `MEM.PIN <scope> <id> [id ...]`: pinned memories never go cold. */
export const memPinCommand = pinCommand('MEM.PIN', true);
/** `MEM.UNPIN <scope> <id> [id ...]`. */
export const memUnpinCommand = pinCommand('MEM.UNPIN', false);

/** `MEM.CONSOLIDATE <scope> [worker ...]`: the workers enqueued now. */
export const memConsolidateCommand: ConnectionCommand = {
  name: 'MEM.CONSOLIDATE',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const workers = argv.slice(2).map((a) => decoder.decode(a).toLowerCase());
      return answer(
        await memory.consolidate(caller(ctx), {
          scope: scopeOf(argv[1]),
          ...(workers.length > 0 ? { workers } : {}),
        }),
        (r) => replies.array(r.enqueued.map(text)),
      );
    }),
};

function jobReply(j: JobView): KvReply {
  return replies.map([
    [text('id'), text(j.id)],
    [text('kind'), text(j.kind)],
    [text('state'), text(j.state)],
    [text('attempts'), replies.integer(j.attempts)],
    [text('deferrals'), replies.integer(j.deferrals)],
    [text('run_at'), replies.integer(j.runAtMs)],
    [text('error'), text(j.error ?? '')],
    ...(j.why ? [[text('why'), text(j.why)] as const] : []),
  ]);
}

/** `MEM.JOBS <scope> [STATE queued|leased|dead] [LIMIT n] [AFTER id]`: jobs and lifecycle counts. */
export const memJobsCommand: ConnectionCommand = {
  name: 'MEM.JOBS',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const o = options(argv, 2, ['STATE', 'LIMIT', 'AFTER'], []);
      if (isReply(o)) return o;
      const limit = integerOption(o.LIMIT);
      if (isReply(limit)) return limit;
      return answer(
        await memory.jobs(caller(ctx), {
          scope: scopeOf(argv[1]),
          ...(typeof o.STATE === 'string' ? { state: o.STATE.toLowerCase() as never } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(typeof o.AFTER === 'string' ? { after: o.AFTER } : {}),
        }),
        (r) =>
          replies.map([
            [text('jobs'), replies.array(r.jobs.map(jobReply))],
            [text('hot'), replies.integer(r.lifecycle.hot)],
            [text('cold'), replies.integer(r.lifecycle.cold)],
            [text('reembed'), flag(r.lifecycle.reembed)],
            [text('embed_model'), text(r.lifecycle.embedModel)],
            [text('clusters'), replies.integer(r.lifecycle.clusters ?? 1)],
          ]),
      );
    }),
};

/** `MEM.EXPORT <scope> [ASOF index|time]`: the scope as `.mcube` bytes. */
export const memExportCommand: ConnectionCommand = {
  name: 'MEM.EXPORT',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const o = options(argv, 2, ['ASOF'], []);
      if (isReply(o)) return o;
      const asOf =
        typeof o.ASOF === 'string'
          ? { asOf: /^\d+$/.test(o.ASOF) ? { index: o.ASOF } : { time: o.ASOF } }
          : {};
      return answer(
        await memory.exportCube(caller(ctx), { scope: scopeOf(argv[1]), ...asOf }),
        (r) => replies.bulk(new Uint8Array(Buffer.from(r.data, 'base64'))),
      );
    }),
};

/** `MEM.IMPORT <scope> <archive> [FORMAT mcube|cogx] [NAME name]`: imported and skipped counts. */
export const memImportCommand: ConnectionCommand = {
  name: 'MEM.IMPORT',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const o = options(argv, 3, ['FORMAT', 'NAME'], []);
      if (isReply(o)) return o;
      return answer(
        await memory.importCube(caller(ctx), {
          scope: scopeOf(argv[1]),
          data: Buffer.from(argv[2] ?? new Uint8Array()).toString('base64'),
          ...(typeof o.FORMAT === 'string' ? { format: o.FORMAT.toLowerCase() as never } : {}),
          ...(typeof o.NAME === 'string' ? { name: o.NAME } : {}),
        }),
        (r) =>
          replies.map([
            [text('imported'), replies.integer(r.imported)],
            [text('skipped'), replies.integer(r.skipped)],
          ]),
      );
    }),
};

/** `MEM.TRACE <scope> <tool> <ok|failed> [ARGS json] [RESULT text]`: remembers a tool call. */
export const memTraceCommand: ConnectionCommand = {
  name: 'MEM.TRACE',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const o = options(argv, 4, ['ARGS', 'RESULT'], []);
      if (isReply(o)) return o;
      const outcome = decoder.decode(argv[3]).toLowerCase();
      if (outcome !== 'ok' && outcome !== 'failed') return replies.errors.syntax();
      let args: unknown;
      if (typeof o.ARGS === 'string')
        try {
          args = JSON.parse(o.ARGS) as unknown;
        } catch {
          return replies.error('INVALID_ARGUMENT', 'ARGS is not JSON');
        }
      return answer(
        await memory.remember(caller(ctx), {
          scope: scopeOf(argv[1]),
          toolTrace: {
            tool: decoder.decode(argv[2]),
            success: outcome === 'ok',
            ...(args !== undefined ? { args } : {}),
            ...(typeof o.RESULT === 'string' ? { result: o.RESULT } : {}),
          },
        }),
        (r) => replies.array(r.ids.map(text)),
      );
    }),
};
