/**
 * Memory scope (PLAN 5.5): tenant / user / agent / session. Every level below
 * `tenant` is optional; a scope is also the default placement unit for memory.
 */
export interface ScopePath {
  readonly tenant: string;
  readonly user?: string;
  readonly agent?: string;
  readonly session?: string;
}
