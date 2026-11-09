import type { FastifyRequest } from 'fastify';
import type { MindlogError, Result } from '@mindlog/core';
import { err, isUserTenant, mindlogError, ok } from '@mindlog/core';
import type { Identity } from '@mindlog/auth';
import type { RequestContext } from '@mindlog/services';
import type { HttpServerDeps } from './http-deps.js';

const TENANT_HEADER = 'x-mindlog-tenant';

/** PocketBase's `@request.headers` names: lower case, `-` as `_`. */
function headersOf(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (k === 'authorization' || k === 'cookie') continue;
    if (typeof v === 'string') out[k.toLowerCase().replace(/-/g, '_')] = v;
  }
  return out;
}

function queryOf(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((request.query ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** The bearer token, if any (`Authorization: Bearer …` or PocketBase's bare `Authorization: …`). */
export function bearerOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization?.trim();
  if (!header) return undefined;
  return header.startsWith('Bearer ') ? header.slice(7).trim() : header;
}

/**
 * Who a full-stack request acts as (PLAN 16.4, 18): a superuser token
 * (ADR-0024), an app JWT (ADR-0035), an API key, or nobody. The tenant comes
 * from the credential, else the `X-Mindlog-Tenant` header, else the default.
 */
export async function identityOf(
  request: FastifyRequest,
  deps: HttpServerDeps,
  token = bearerOf(request),
): Promise<Result<{ identity: Identity; tenant: string }, MindlogError>> {
  const header = request.headers[TENANT_HEADER];
  const named =
    typeof header === 'string' && header !== '' ? header : (deps.defaultTenant ?? 'default');
  if (!isUserTenant(named)) return err(mindlogError('INVALID_ARGUMENT', `invalid tenant ${named}`));
  if (token === undefined || token === '')
    return ok({ identity: { kind: 'anonymous' }, tenant: named });
  if (token.startsWith('mlk_')) {
    const key = deps.apiKeys
      ? await deps.apiKeys.verify(token)
      : err(mindlogError('UNAUTHENTICATED', 'API keys are off'));
    if (!key.ok) return key;
    const { id, tenant, user, role, scopes } = key.value;
    return ok({
      identity: {
        kind: 'apiKey',
        id,
        tenant,
        role,
        ...(user ? { user } : {}),
        ...(scopes ? { scopes } : {}),
      },
      tenant,
    });
  }
  if (token.split('.').length === 3 && deps.appAuth) {
    const app = await deps.appAuth.authenticate(token);
    if (!app.ok) return app;
    const id = app.value;
    return ok({ identity: id, tenant: 'tenant' in id ? id.tenant : named });
  }
  const superuser = await deps.admin.verifyToken(token);
  if (!superuser.ok) return superuser;
  const { email, role, tenant } = superuser.value;
  if (role && tenant) return ok({ identity: { kind: 'member', tenant, email, role }, tenant });
  return ok({ identity: { kind: 'superuser', email }, tenant: named });
}

/** The request as rules see it (`@request.query`, `headers`, `method`, `context`). */
export async function contextOf(
  request: FastifyRequest,
  deps: HttpServerDeps,
  context = 'default',
): Promise<Result<RequestContext, MindlogError>> {
  const who = await identityOf(request, deps);
  if (!who.ok) return who;
  return ok({
    ...who.value,
    query: queryOf(request),
    headers: headersOf(request),
    method: request.method,
    context,
  });
}
