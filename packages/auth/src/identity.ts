/**
 * Who a request acts as (PLAN 18). Rules see `@request.auth` as the record of
 * a `record` or `delegated` identity; superusers bypass rules; API keys
 * without a user and guests see no auth record.
 */
export type Identity =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'superuser'; readonly email: string }
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
