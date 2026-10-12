import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { ParseEvent } from '@mindlog/adapter-resp';
import { RespParser } from '@mindlog/adapter-resp';

/**
 * Fuzz target for the request parser (CLAUDE.md §11). `pnpm test` runs a small
 * budget; `pnpm fuzz:resp` sets FUZZ_RUNS for a long run.
 */
const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
const SEED = process.env.FUZZ_SEED === undefined ? {} : { seed: Number(process.env.FUZZ_SEED) };
const options = { numRuns: RUNS, ...SEED };

const frame = (args: readonly Uint8Array[]): Buffer =>
  Buffer.concat([
    Buffer.from(`*${String(args.length)}\r\n`),
    ...args.flatMap((a) => [
      Buffer.from(`$${String(a.length)}\r\n`),
      Buffer.from(a),
      Buffer.from('\r\n'),
    ]),
  ]);

/** Parses `bytes` split at `cuts`, as a socket might deliver them. */
function parse(bytes: Uint8Array, cuts: readonly number[] = []): ParseEvent[] {
  const parser = new RespParser({
    maxBulkBytes: 1 << 20,
    maxInlineBytes: 64 * 1024,
    maxArgs: 1024,
  });
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const events: ParseEvent[] = [];
  let last = 0;
  for (const cut of [...points, bytes.length]) {
    events.push(...parser.push(Buffer.from(bytes.subarray(last, cut))));
    last = cut;
  }
  return events;
}

const normalise = (events: ParseEvent[]) =>
  events.map((e) =>
    e.kind === 'error' ? e.message : e.argv.map((a) => Buffer.from(a).toString('hex')),
  );

/** Byte-level mutations of a valid pipeline: flips, insertions, deletions. */
const mutation = fc.oneof(
  fc.record({
    op: fc.constant('flip' as const),
    at: fc.nat(),
    byte: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({
    op: fc.constant('insert' as const),
    at: fc.nat(),
    byte: fc.constantFrom(0x0d, 0x0a, 0x2a, 0x24, 0x2d, 0x30, 0x39, 0x22, 0x20),
  }),
  fc.record({ op: fc.constant('delete' as const), at: fc.nat(), byte: fc.constant(0) }),
);

function mutate(
  bytes: Uint8Array,
  mutations: readonly { op: string; at: number; byte: number }[],
): Uint8Array {
  const out = [...bytes];
  for (const m of mutations) {
    const at = out.length === 0 ? 0 : m.at % out.length;
    if (m.op === 'flip' && out.length > 0) out[at] = m.byte;
    else if (m.op === 'insert') out.splice(at, 0, m.byte);
    else if (m.op === 'delete') out.splice(at, 1);
  }
  return Uint8Array.from(out);
}

const pipeline = fc
  .array(fc.array(fc.uint8Array({ maxLength: 24 }), { minLength: 1, maxLength: 4 }), {
    minLength: 1,
    maxLength: 4,
  })
  .map((commands) => Buffer.concat(commands.map(frame)));

describe('RESP parser fuzz', () => {
  test('random bytes: never throws, errors are final, chunking never changes the result', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 256 }),
        fc.array(fc.nat(), { maxLength: 8 }),
        (bytes, cuts) => {
          const whole = parse(bytes);
          expect(normalise(parse(bytes, cuts))).toEqual(normalise(whole));
          const error = whole.findIndex((e) => e.kind === 'error');
          expect(error === -1 || error === whole.length - 1).toBe(true);
        },
      ),
      options,
    );
  });

  test('mutated valid pipelines: never throws and chunking never changes the result', () => {
    fc.assert(
      fc.property(
        pipeline,
        fc.array(mutation, { minLength: 1, maxLength: 4 }),
        fc.array(fc.nat(), { maxLength: 8 }),
        (bytes, mutations, cuts) => {
          const mutated = mutate(bytes, mutations);
          expect(normalise(parse(mutated, cuts))).toEqual(normalise(parse(mutated)));
        },
      ),
      options,
    );
  });

  test('valid pipelines round-trip under any chunking', () => {
    const commands = fc.array(
      fc.array(fc.uint8Array({ maxLength: 64 }), { minLength: 1, maxLength: 6 }),
      {
        minLength: 1,
        maxLength: 6,
      },
    );
    fc.assert(
      fc.property(commands, fc.array(fc.nat(), { maxLength: 16 }), (cmds, cuts) => {
        const bytes = Buffer.concat(cmds.map(frame));
        expect(normalise(parse(bytes, cuts))).toEqual(
          cmds.map((c) => c.map((a) => Buffer.from(a).toString('hex'))),
        );
      }),
      options,
    );
  });
});
