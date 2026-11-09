import type { Access } from '@mindlog/auth';

/** A MULTI in progress: queued commands, and whether queueing failed. */
export interface PendingTransaction {
  readonly queued: Uint8Array[][];
  failed: boolean;
}

export interface WatchedKey {
  readonly key: Uint8Array;
  readonly version: bigint;
}

/**
 * Per-connection state shared by every protocol adapter: identity, tenant,
 * and transaction state (MULTI queue, WATCHed keys).
 */
export class Session {
  /** Tenant whose keyspace this session uses (CLAUDE.md rule 10). */
  tenant: string;
  principal = 'anonymous';
  authenticated: boolean;
  /** Set when an API key authenticated the session; absent is the static user or internal work. */
  access: Access | undefined;
  /** Gives back this session's tenant connection slot. */
  release: (() => void) | undefined;
  transaction: PendingTransaction | undefined;
  readonly watches = new Map<string, WatchedKey>();

  constructor(
    readonly id: string,
    tenant: string,
    authenticated: boolean,
  ) {
    this.tenant = tenant;
    this.authenticated = authenticated;
  }

  /** Clears MULTI and WATCH state (after EXEC, DISCARD or RESET). */
  resetTransaction(): void {
    this.transaction = undefined;
    this.watches.clear();
  }
}
