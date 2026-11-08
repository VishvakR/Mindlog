import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

// Runs inside the hook worker (ADR-0035); only erasable TypeScript, because Node strips the types in tests.

type HookEvent = Record<string, unknown> & { body?: Record<string, unknown> };
type Handler = (e: HookEvent) => unknown;

interface CallMessage {
  readonly id: number;
  readonly kind: 'hook' | 'cron';
  readonly key?: readonly string[];
  readonly name?: string;
  readonly event?: HookEvent;
}

const handlers = new Map<string, Handler[]>();
const crons = new Map<string, { expr: string; run: () => unknown }>();

const add = (key: string, fn: Handler): void => {
  handlers.set(key, [...(handlers.get(key) ?? []), fn]);
};
const onRecord =
  (event: string) =>
  (collection: string, phase: 'before' | 'after', fn: Handler): void => {
    add(`${event}/${collection}/${phase}`, fn);
  };
const app = {
  onRecordCreate: onRecord('onRecordCreate'),
  onRecordUpdate: onRecord('onRecordUpdate'),
  onRecordDelete: onRecord('onRecordDelete'),
  onAuth: (collection: string, fn: Handler): void => {
    add(`onAuth/${collection}/before`, fn);
  },
  onFileUpload: (collection: string, fn: Handler): void => {
    add(`onFileUpload/${collection}/before`, fn);
  },
  cronAdd: (name: string, expr: string, run: () => unknown): void => {
    crons.set(name, { expr, run });
  },
};

const port = parentPort;
if (!port) throw new Error('hook-worker runs in a worker thread');

for (const file of (workerData as { files: string[] }).files) {
  const mod = (await import(pathToFileURL(file).href)) as { default?: (a: typeof app) => unknown };
  if (typeof mod.default !== 'function') throw new Error(`${file} has no default export function`);
  await mod.default(app);
}
port.postMessage({
  ready: true,
  hooks: [...handlers.keys()],
  crons: [...crons].map(([name, c]) => ({ name, expr: c.expr })),
});

port.on('message', (m: CallMessage) => {
  void (async () => {
    try {
      if (m.kind === 'cron') await crons.get(m.name ?? '')?.run();
      const event = m.event ?? {};
      for (const key of m.key ?? []) for (const fn of handlers.get(key) ?? []) await fn(event);
      port.postMessage({ id: m.id, ok: true, body: event.body ?? {} });
    } catch (e) {
      port.postMessage({
        id: m.id,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  })();
});
