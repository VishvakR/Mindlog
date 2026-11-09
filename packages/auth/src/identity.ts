import type { Access, Role } from './policy.js';

/**
 * Who a request acts as (PLAN 18). Rules see `@request.auth` as the record of
 * a `record` or `delegated` identity; superusers bypass rules; API keys
 * without a user and guests see no auth record.
 */
export type Identity =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'superuser'; readonly email: string }
  | {
      /** A dashboard account limited to one tenant and role. */
      readonly kind: 'member';
      readonly tenant: string;
      readonly email: string;
      readonly role: Role;
    }
  | {
      readonly kind: 'record';
      readonly tenant: string;
      readonly collection: string;
      readonly id: string;
    }
  | {
      readonly kind: 'apiKey';
      readonly tenant: string;
      readonly id: string;
      readonly user?: string;
      /** Keys made before roles existed are agents. */
      readonly role?: Role;
      readonly scopes?: readonly string[];
    }
  | {
      readonly kind: 'delegated';
      readonly tenant: string;
      readonly collection: string;
      readonly id: string;
      /** API key id of the agent acting for the user. */
      readonly actor: string;
    };

export const ANONYMOUS: Identity = { kind: 'anonymous' };

/** The principal commands record (`Command.principal`). */
export function principalOf(identity: Identity): string {
  switch (identity.kind) {
    case 'anonymous':
      return 'anonymous';
    case 'superuser':
      return `superuser:${identity.email}`;
    case 'member':
      return `member:${identity.email}`;
    case 'record':
    case 'delegated':
      return `${identity.collection}:${identity.id}`;
    case 'apiKey':
      return `apikey:${identity.id}`;
  }
}

/** The acting agent of a delegated identity (`Command.actor`), else ''. */
export function actorOf(identity: Identity): string {
  return identity.kind === 'delegated' ? `apikey:${identity.actor}` : '';
}

/** What `decide` needs to know about an identity; undefined for guests, who hold no role. */
export function accessOf(identity: Identity): Access | undefined {
  const subject = principalOf(identity);
  switch (identity.kind) {
    case 'anonymous':
      return undefined;
    case 'superuser':
      return { role: 'superuser', subject };
    case 'member':
      return { role: identity.role, tenant: identity.tenant, subject };
    case 'record':
    case 'delegated':
      return { role: 'app_user', tenant: identity.tenant, subject };
    case 'apiKey':
      return {
        role: identity.role ?? 'agent',
        tenant: identity.tenant,
        subject,
        ...(identity.user === undefined ? {} : { user: identity.user }),
        ...(identity.scopes === undefined ? {} : { scopes: identity.scopes }),
      };
  }
}
