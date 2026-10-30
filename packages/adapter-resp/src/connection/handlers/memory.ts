import type { MindlogError, Result } from '@mindlog/core';
import { parseInteger, replies } from '@mindlog/kv';
import type { MemoryView } from '@mindlog/memory';
import type { KvReply } from '@mindlog/proto';
import type { MemoryService } from '@mindlog/services';
import type { ConnectionCommand, ConnectionContext } from '../connection-command.js';

const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const text = (value: string): KvReply => replies.bulk(encoder.encode(value));
export const flag = (value: boolean): KvReply => replies.integer(value ? 1 : 0);

export function withMemory(
  ctx: ConnectionContext,
  run: (memory: MemoryService) => Promise<KvReply>,
): KvReply | Promise<KvReply> {
  const memory = ctx.server.memory;
  return memory ? run(memory) : replies.error('UNIMPLEMENTED', 'memory commands are not available');
}

/** `user[/agent[/session]]` under the session's tenant (PLAN 5.5). */
export function scopeOf(arg: Uint8Array | undefined): {
  user: string;
  agent?: string;
  session?: string;
} {
  const [user = '', agent, session] = decoder.decode(arg ?? new Uint8Array()).split('/');
  return { user, ...(agent ? { agent } : {}), ...(session ? { session } : {}) };
}

export const caller = (ctx: ConnectionContext) => ({
  tenant: ctx.session.tenant,
  principal: ctx.session.principal,
});

export function answer<T>(result: Result<T, MindlogError>, render: (value: T) => KvReply): KvReply {
  return result.ok ? render(result.value) : replies.error(result.error.code, result.error.message);
}

export function memoryReply(m: MemoryView): KvReply {
  return replies.map([
    [text('id'), text(m.id)],
    [text('kind'), text(m.kind)],
    [text('text'), text(m.text)],
    [text('user'), text(m.user)],
    [text('agent'), text(m.agent ?? '')],
    [text('session'), text(m.session ?? '')],
    [text('trust'), text(m.trust)],
    [text('importance'), replies.double(m.importance)],
    [text('entities'), replies.array(m.entities.map(text))],
    [text('created_at'), replies.integer(m.createdAtMs)],
    [text('expired'), flag(m.expiredAtMs !== undefined)],
    ...(m.validFromMs === undefined
      ? []
      : [[text('valid_from'), replies.integer(m.validFromMs)] as const]),
    ...(m.validToMs === undefined
      ? []
      : [[text('valid_to'), replies.integer(m.validToMs)] as const]),
  ]);
}

type Options = Record<string, string | true>;

/** Parses `TOKEN value` and bare `TOKEN` options after the positional arguments. */
export function options(
  argv: readonly Uint8Array[],
  from: number,
  valued: readonly string[],
  bare: readonly string[],
): Options | KvReply {
  const out: Options = {};
  for (let i = from; i < argv.length; i++) {
    const token = decoder.decode(argv[i]).toUpperCase();
    if (bare.includes(token)) out[token] = true;
    else if (valued.includes(token) && i + 1 < argv.length) out[token] = decoder.decode(argv[++i]);
    else return replies.errors.syntax();
  }
  return out;
}

export function integerOption(value: string | true | undefined): number | undefined | KvReply {
  if (value === undefined || value === true) return undefined;
  const n = parseInteger(encoder.encode(value));
  return n === undefined
    ? replies.error('INVALID_ARGUMENT', 'value is not an integer or out of range')
    : Number(n);
}

export const isReply = (x: unknown): x is KvReply =>
  typeof x === 'object' && x !== null && '$typeName' in x;

/** A time argument: ms since the epoch or ISO 8601 (the service validates it). */
export const timeOf = (v: string): number | string => (/^\d+$/.test(v) ? Number(v) : v);

/** `ASOF <log index>` or `ASOF <ISO time>` (PLAN 13.3). */
const asOfOf = (v: string | true | undefined) =>
  typeof v !== 'string' ? {} : { asOf: /^\d+$/.test(v) ? { index: v } : { time: v } };

const timeOption = (name: string, v: string | true | undefined) =>
  typeof v === 'string' ? { [name]: timeOf(v) } : {};

/** `MEM.ADD <scope> <text> [KIND kind] [SOURCE type] [VALID_FROM t] [VALID_TO t] [ASYNC]`. */
export const memAddCommand: ConnectionCommand = {
  name: 'MEM.ADD',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const o = options(argv, 3, ['KIND', 'SOURCE', 'VALID_FROM', 'VALID_TO'], ['ASYNC']);
      if (isReply(o)) return o;
      const result = await memory.remember(caller(ctx), {
        scope: scopeOf(argv[1]),
        content: decoder.decode(argv[2]),
        ...(typeof o.KIND === 'string' ? { kind: o.KIND.toLowerCase() as never } : {}),
        ...(typeof o.SOURCE === 'string'
          ? { source: { type: o.SOURCE.toLowerCase() as never } }
          : {}),
        ...(o.ASYNC ? { async: true } : {}),
        ...timeOption('validFrom', o.VALID_FROM),
        ...timeOption('validTo', o.VALID_TO),
      });
      return answer(result, (r) =>
        replies.map([
          [text('ids'), replies.array(r.ids.map(text))],
          [text('degraded'), flag(r.degraded)],
          ...(r.jobId ? [[text('job'), text(r.jobId)] as const] : []),
        ]),
      );
    }),
};

/** The recall options of MEM.SEARCH and MEM.PACK. */
function recallRequest(
  argv: readonly Uint8Array[],
): Parameters<MemoryService['recall']>[1] | KvReply {
  const o = options(argv, 3, ['K', 'BUDGET', 'RECIPE', 'ASOF', 'VALID_AT'], ['INHERIT']);
  if (isReply(o)) return o;
  const k = integerOption(o.K);
  const budget = integerOption(o.BUDGET);
  if (isReply(k)) return k;
  if (isReply(budget)) return budget;
  return {
    scope: scopeOf(argv[1]),
    query: decoder.decode(argv[2]),
    ...(k !== undefined ? { k } : {}),
    ...(budget !== undefined ? { tokenBudget: budget } : {}),
    ...(o.INHERIT ? { inherit: true } : {}),
    ...(typeof o.RECIPE === 'string' ? { recipe: o.RECIPE.toLowerCase() as never } : {}),
    ...asOfOf(o.ASOF),
    ...timeOption('validAt', o.VALID_AT),
  };
}

/** `MEM.SEARCH <scope> <query> [K n] [BUDGET tokens] [INHERIT] [RECIPE name] [ASOF index|time] [VALID_AT t]`. */
export const memSearchCommand: ConnectionCommand = {
  name: 'MEM.SEARCH',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const request = recallRequest(argv);
      if (isReply(request)) return request;
      return answer(await memory.recall(caller(ctx), request), (r) =>
        replies.array(
          r.items.map((item) =>
            replies.map([
              [text('id'), text(item.memory.id)],
              [text('text'), text(item.memory.text)],
              [text('kind'), text(item.memory.kind)],
              [text('score'), replies.double(Math.round(item.score * 1e6) / 1e6)],
            ]),
          ),
        ),
      );
    }),
};

/** `MEM.PACK <scope> <query> [BUDGET tokens] [INHERIT] [RECIPE name]`: the packed context and its accounting. */
export const memPackCommand: ConnectionCommand = {
  name: 'MEM.PACK',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const request = recallRequest(argv);
      if (isReply(request)) return request;
      return answer(await memory.recall(caller(ctx), request), (r) =>
        replies.map([
          [text('context'), text(r.context)],
          [text('tokens'), replies.integer(r.tokens)],
          [text('budget'), replies.integer(r.budget)],
          [text('ids'), replies.array(r.groups.flatMap((g) => g.ids).map(text))],
          [text('dropped'), replies.array(r.dropped.map(text))],
          [text('compressed'), replies.array(r.compressed.map(text))],
          [text('degraded'), flag(r.degraded)],
        ]),
      );
    }),
};

/** `MEM.GET <scope> <id> [ASOF index|time]`. */
export const memGetCommand: ConnectionCommand = {
  name: 'MEM.GET',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const o = options(argv, 3, ['ASOF'], []);
      if (isReply(o)) return o;
      return answer(
        await memory.get(caller(ctx), {
          scope: scopeOf(argv[1]),
          id: decoder.decode(argv[2]),
          ...asOfOf(o.ASOF),
        }),
        (m) => (m ? memoryReply(m) : replies.nil()),
      );
    }),
};

/** `MEM.FORGET <scope> <id> [id ...]`. */
export const memForgetCommand: ConnectionCommand = {
  name: 'MEM.FORGET',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) =>
      answer(
        await memory.forget(caller(ctx), {
          scope: scopeOf(argv[1]),
          ids: argv.slice(2).map((a) => decoder.decode(a)),
          reason: `MEM.FORGET by ${ctx.session.principal}`,
        }),
        (r) => replies.integer(r.count),
      ),
    ),
};

/** `MEM.HISTORY <scope> <id>`: versions newest first. */
export const memHistoryCommand: ConnectionCommand = {
  name: 'MEM.HISTORY',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) =>
      answer(
        await memory.history(caller(ctx), { scope: scopeOf(argv[1]), id: decoder.decode(argv[2]) }),
        (versions) =>
          replies.array(
            versions.map((v) =>
              replies.map([
                [text('version'), text(v.version)],
                [text('at'), replies.integer(v.atMs)],
                [text('text'), text(v.memory.text)],
                [text('expired'), flag(v.memory.expiredAtMs !== undefined)],
              ]),
            ),
          ),
      ),
    ),
};

/** `CACHE.SET <scope> <prompt> <answer> [USING id ...] [TTL seconds]`: the new entry's id. */
export const cacheSetCommand: ConnectionCommand = {
  name: 'CACHE.SET',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const using: string[] = [];
      let ttl: number | undefined;
      for (let i = 4; i < argv.length; i++) {
        const token = decoder.decode(argv[i]).toUpperCase();
        if (token === 'TTL' && i + 1 < argv.length) {
          const n = integerOption(decoder.decode(argv[++i]));
          if (isReply(n)) return n;
          ttl = n;
        } else if (token === 'USING') {
          while (i + 1 < argv.length && decoder.decode(argv[i + 1]).toUpperCase() !== 'TTL')
            using.push(decoder.decode(argv[++i]));
        } else return replies.errors.syntax();
      }
      return answer(
        await memory.cacheStore(caller(ctx), {
          scope: scopeOf(argv[1]),
          prompt: decoder.decode(argv[2]),
          answer: decoder.decode(argv[3]),
          ...(using.length > 0 ? { dependsOn: using } : {}),
          ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
        }),
        (r) => text(r.id),
      );
    }),
};

/** `CACHE.GET <scope> <prompt> [THRESHOLD t]`: nil on a miss, else the answer and how it matched. */
export const cacheGetCommand: ConnectionCommand = {
  name: 'CACHE.GET',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) => {
      const o = options(argv, 3, ['THRESHOLD'], []);
      if (isReply(o)) return o;
      const threshold = typeof o.THRESHOLD === 'string' ? Number(o.THRESHOLD) : undefined;
      if (threshold !== undefined && !Number.isFinite(threshold))
        return replies.error('INVALID_ARGUMENT', 'threshold is not a number');
      return answer(
        await memory.cacheLookup(caller(ctx), {
          scope: scopeOf(argv[1]),
          prompt: decoder.decode(argv[2]),
          ...(threshold !== undefined ? { threshold } : {}),
        }),
        ({ hit }) =>
          hit
            ? replies.map([
                [text('id'), text(hit.id)],
                [text('answer'), text(hit.answer)],
                [text('similarity'), replies.double(Math.round(hit.similarity * 1e6) / 1e6)],
                [text('level'), text(hit.level)],
                [text('using'), replies.array(hit.dependsOn.map(text))],
              ])
            : replies.nil(),
      );
    }),
};

/** `CACHE.DEL <scope> <id> [id ...]`: how many entries were dropped. */
export const cacheDelCommand: ConnectionCommand = {
  name: 'CACHE.DEL',
  execute: (ctx, argv) =>
    withMemory(ctx, async (memory) =>
      answer(
        await memory.cacheDelete(caller(ctx), {
          scope: scopeOf(argv[1]),
          ids: argv.slice(2).map((a) => decoder.decode(a)),
        }),
        (r) => replies.integer(r.count),
      ),
    ),
};
