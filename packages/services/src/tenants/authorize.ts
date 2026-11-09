import type { Access, Action, Resource } from '@mindlog/auth';
import type { MindlogError, Result } from '@mindlog/core';

/** Authorizes one action. Every interface reaches data through this check. */
export type Authorize = (
  access: Access | undefined,
  action: Action,
  resource: Resource,
) => Promise<Result<void, MindlogError>>;
