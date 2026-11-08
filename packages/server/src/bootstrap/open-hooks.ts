import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Logger, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { parseCron } from '@mindlog/collections';
import type { CronEntry, HookCall, HookEvent, HookPhase, RecordHooks } from '@mindlog/services';

const WORKER = new URL(
  `./hook-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
  import.meta.url,
);
const HOOK_TIMEOUT_MS = 5_000;
const CRON_TIMEOUT_MS = 60_000;
const MAX_QUEUED = 256;
const CRON_NAME = /^[A-Za-z0-9_-]{1,64}$/;

interface Ready {
  readonly hooks: readonly string[];
  readonly crons: readonly CronEntry[];
}
type Reply = { ok: true; body: Record<string, unknown> } | { ok: false; message: string };

/**
 * Hooks from a folder, in a worker thread with a memory cap and a per-call
 * timeout (PLAN 16.8). The limits stop runaway code; they are not a security
 * boundary, since hooks are the operator's own code (ADR-0035).
 *
 * shortcut: one worker runs one call at a time; add a pool if hooks become a bottleneck.
 */
export class WorkerHooks implements RecordHooks {
  #worker: Worker | undefined;
  #hooks = new Set<string>();
  #crons: readonly CronEntry[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #seq = 0;
  #closed = false;
  readonly #waiting = new Map<number, (r: Reply) => void>();

  private constructor(
    private readonly files: readonly string[],
    private readonly logger: Logger,
  ) {}

  /** Loads the folder's hooks; `undefined` when no folder is configured. */
  static async open(
    dir: string,
    logger: Logger,
  ): Promise<Result<WorkerHooks | undefined, MindlogError>> {
    if (dir === '') return ok(undefined);
    let names: string[];
    try {
      names = await readdir(resolve(dir));
    } catch (cause) {
      return err(mindlogError('CONFIG_INVALID', `cannot read hooks folder ${dir}`, { cause }));
    }
    const files = names
      .filter((n) => /\.(ts|js|mjs)$/.test(n) && !n.endsWith('.d.ts'))
      .sort()
      .map((n) => join(resolve(dir), n));
    const hooks = new WorkerHooks(files, logger);
    const started = await hooks.#spawn();
    return started.ok ? ok(hooks) : started;
  }

  #spawn(): Promise<Result<void, MindlogError>> {
    return new Promise((done) => {
      const worker = new Worker(WORKER, {
        workerData: { files: this.files },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      });
      let ready = false;
      worker.on(
        'message',
        (m: Partial<Ready> & { ready?: boolean; id?: number } & Partial<Reply>) => {
          if (m.ready) {
            const bad = m.crons?.find((c) => !CRON_NAME.test(c.name) || !parseCron(c.expr));
            if (bad) {
              void worker.terminate();
              done(err(mindlogError('CONFIG_INVALID', `invalid cron ${bad.name}: ${bad.expr}`)));
              return;
            }
            ready = true;
            this.#hooks = new Set(m.hooks);
            this.#crons = m.crons ?? [];
            this.#worker = worker;
            done(ok(undefined));
            return;
          }
          if (m.id !== undefined) this.#waiting.get(m.id)?.(m as Reply);
        },
      );
      const failed = (cause: unknown) => {
        if (this.#worker === worker) this.#worker = undefined;
        for (const reply of this.#waiting.values())
          reply({ ok: false, message: 'the hook worker stopped' });
        if (!ready)
          done(
            err(
              mindlogError(
                'CONFIG_INVALID',
                `hooks failed to load: ${cause instanceof Error ? cause.message : String(cause)}`,
                { cause },
              ),
            ),
          );
      };
      worker.on('error', (e) => {
        if (!this.#closed) this.logger.error('hook worker failed', { err: e });
        failed(e);
      });
      worker.on('exit', (code) => {
        failed(new Error(`exit code ${String(code)}`));
      });
    });
  }

  /** One call at a time; a timeout kills the worker, and the next call starts a new one. */
  #call(
    message: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Result<Record<string, unknown>, MindlogError>> {
    if (this.#queued >= MAX_QUEUED)
      return Promise.resolve(err(mindlogError('BUSY', 'too many hooks are waiting')));
    this.#queued++;
    const run = async (): Promise<Result<Record<string, unknown>, MindlogError>> => {
      if (!this.#worker) {
        const started = await this.#spawn();
        if (!started.ok) return started;
      }
      const worker = this.#worker;
      if (!worker) return err(mindlogError('UNAVAILABLE', 'the hook worker is not running'));
      const id = ++this.#seq;
      const reply = await new Promise<Reply | 'timeout'>((resolved) => {
        const timer = setTimeout(() => {
          resolved('timeout');
        }, timeoutMs);
        this.#waiting.set(id, (r) => {
          clearTimeout(timer);
          resolved(r);
        });
        worker.postMessage({ id, ...message });
      });
      this.#waiting.delete(id);
      if (reply === 'timeout') {
        this.#worker = undefined;
        await worker.terminate();
        return err(
          mindlogError('DEADLINE_EXCEEDED', `a hook ran for over ${String(timeoutMs)} ms`),
        );
      }
      return reply.ok ? ok(reply.body) : err(mindlogError('INVALID_ARGUMENT', reply.message));
    };
    const result = this.#chain.then(run);
    this.#chain = result
      .catch(() => undefined)
      .finally(() => {
        this.#queued--;
      });
    return result;
  }

  has(event: HookEvent, collection: string, phase: HookPhase): boolean {
    return (
      this.#hooks.has(`${event}/${collection}/${phase}`) || this.#hooks.has(`${event}/*/${phase}`)
    );
  }

  run(call: HookCall): Promise<Result<Readonly<Record<string, unknown>>, MindlogError>> {
    const key = [`${call.event}/*/${call.phase}`, `${call.event}/${call.collection}/${call.phase}`];
    const event = {
      collection: call.collection,
      ...(call.record ? { record: call.record } : {}),
      ...(call.file ? { file: call.file } : {}),
      body: { ...call.body },
    };
    return this.#call({ kind: 'hook', key, event }, HOOK_TIMEOUT_MS);
  }

  crons(): readonly CronEntry[] {
    return this.#crons;
  }

  async runCron(name: string): Promise<Result<void, MindlogError>> {
    const ran = await this.#call({ kind: 'cron', name }, CRON_TIMEOUT_MS);
    return ran.ok ? ok(undefined) : ran;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#worker?.terminate();
    this.#worker = undefined;
  }
}
