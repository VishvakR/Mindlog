import type { MindlogError, Result } from '@mindlog/core';

export type HookEvent =
  'onRecordCreate' | 'onRecordUpdate' | 'onRecordDelete' | 'onAuth' | 'onFileUpload';
export type HookPhase = 'before' | 'after';

export interface HookCall {
  readonly event: HookEvent;
  readonly collection: string;
  readonly phase: HookPhase;
  /** The record, hidden fields included: hooks are code the operator installed. */
  readonly record?: Readonly<Record<string, unknown>>;
  /** A write's request body; a before hook may change it. */
  readonly body?: Readonly<Record<string, unknown>>;
  readonly file?: {
    readonly field: string;
    readonly filename: string;
    readonly mimetype: string;
    readonly size: number;
  };
}

export interface CronEntry {
  readonly name: string;
  readonly expr: string;
}

/** The operator's hooks (PLAN 16.8); the server runs them in a worker thread. */
export interface RecordHooks {
  has(event: HookEvent, collection: string, phase: HookPhase): boolean;
  /** Resolves with the (possibly changed) body; an error refuses a before hook's operation. */
  run(call: HookCall): Promise<Result<Readonly<Record<string, unknown>>, MindlogError>>;
  crons(): readonly CronEntry[];
  runCron(name: string): Promise<Result<void, MindlogError>>;
}
