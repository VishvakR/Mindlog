import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { RateLimiter } from '@mindlog/auth';
import type { HttpServerDeps } from '../http-deps.js';
import { bearerOf, identityOf } from '../identity.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const record = z.record(z.string(), z.unknown());
const authResponse = z.object({ token: z.string(), refreshToken: z.string().optional(), record });
const email = z.object({ email: z.string().max(254) });
const missing = () => err(mindlogError('UNIMPLEMENTED', 'app auth is not available on this node'));

/** Auth endpoints of auth collections (PLAN 16.4, ADR-0035), rate limited per client address. */
export function recordAuthRoutes(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  deps: HttpServerDeps,
): void {
  const auth = deps.appAuth;
  const rate = deps.authRateLimit ?? { burst: 20, perMinute: 30 };
  const limiter = new RateLimiter({
    burst: rate.burst,
    perSecond: rate.perMinute / 60,
    maxKeys: 10_000,
  });
  const limited = (request: FastifyRequest): Result<void, MindlogError> =>
    limiter.take(request.ip, Number(deps.clock.now()))
      ? ok(undefined)
      : err(mindlogError('RATE_LIMITED', 'Too many requests; slow down.'));
  /** The tenant of the request (from the header or the default; credentials may not exist yet). */
  const tenantOf = async (request: FastifyRequest) => {
    const who = await identityOf(request, deps, undefined);
    return who.ok ? ok(who.value.tenant) : who;
  };
  const post = <B extends z.ZodType, R extends z.ZodType>(
    path: string,
    summary: string,
    body: B,
    response: R | undefined,
    run: (
      tenant: string,
      collection: string,
      body: z.infer<B>,
      request: FastifyRequest,
    ) => Promise<Result<z.infer<R> | undefined, MindlogError>>,
  ) => {
    defineRoute(
      app,
      routes,
      {
        method: 'POST',
        path: `/api/collections/:collection/${path}`,
        summary,
        tag: 'auth',
        auth: false,
        body,
        ...(response ? { response } : {}),
      },
      async ({ request, params, body: b }) => {
        if (!auth) return missing();
        const allowed = limited(request);
        if (!allowed.ok) return allowed;
        const tenant = await tenantOf(request);
        return tenant.ok ? run(tenant.value, params['collection'] ?? '', b, request) : tenant;
      },
    );
  };

  post(
    'auth-with-password',
    'Sign in with email and password',
    z.object({ identity: z.string().max(254), password: z.string().max(1024) }),
    authResponse,
    (t, c, b) =>
      auth ? auth.authWithPassword(t, c, b.identity, b.password) : Promise.resolve(missing()),
  );
  post(
    'auth-refresh',
    'A new access token from a valid one (Authorization) or from a refresh token (rotated)',
    z.object({ refreshToken: z.string().max(256).optional() }),
    authResponse,
    async (t, c, b, request) => {
      if (!auth) return missing();
      const token = bearerOf(request);
      return auth.refresh(
        t,
        c,
        b.refreshToken !== undefined
          ? { refreshToken: b.refreshToken }
          : token !== undefined
            ? { token }
            : {},
      );
    },
  );
  post(
    'request-otp',
    'Email a one-time code (opt-in)',
    email,
    z.object({ otpId: z.string() }),
    (t, c, b) => (auth ? auth.requestOtp(t, c, b.email) : Promise.resolve(missing())),
  );
  post(
    'auth-with-otp',
    'Sign in with a one-time code (opt-in)',
    z.object({ otpId: z.string().max(64), password: z.string().max(16) }),
    authResponse,
    (t, c, b) => (auth ? auth.authWithOtp(t, c, b.otpId, b.password) : Promise.resolve(missing())),
  );
  post(
    'auth-with-oauth2',
    'Sign in with an OAuth2 provider code (opt-in)',
    z.object({
      provider: z.string().max(32),
      code: z.string().max(2048),
      state: z.string().max(4096),
    }),
    authResponse,
    (t, c, b) => (auth ? auth.authWithOAuth2(t, c, b) : Promise.resolve(missing())),
  );
  post('request-verification', 'Email a verification link (opt-in)', email, undefined, (t, c, b) =>
    auth ? auth.requestVerification(t, c, b.email) : Promise.resolve(missing()),
  );
  post(
    'confirm-verification',
    'Confirm an email with its token',
    z.object({ token: z.string().max(4096) }),
    undefined,
    (t, c, b) => (auth ? auth.confirmVerification(t, c, b.token) : Promise.resolve(missing())),
  );
  post(
    'request-password-reset',
    'Email a password reset link (opt-in)',
    email,
    undefined,
    (t, c, b) => (auth ? auth.requestPasswordReset(t, c, b.email) : Promise.resolve(missing())),
  );
  post(
    'confirm-password-reset',
    'Set a new password with a reset token',
    z.object({
      token: z.string().max(4096),
      password: z.string().max(1024),
      passwordConfirm: z.string().max(1024),
    }),
    undefined,
    (t, c, b) => (auth ? auth.confirmPasswordReset(t, c, b) : Promise.resolve(missing())),
  );

  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/collections/:collection/auth-methods',
      summary:
        'Sign-in methods this collection allows; OAuth2 entries carry their authorize URL and state',
      tag: 'auth',
      auth: false,
      query: z.object({ redirectUrl: z.url().optional() }),
      response: record,
    },
    async ({ request, params, query }) => {
      if (!auth) return missing();
      const tenant = await tenantOf(request);
      if (!tenant.ok) return tenant;
      return auth.authMethods(tenant.value, params['collection'] ?? '', query.redirectUrl);
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'POST',
      path: '/api/auth/delegate',
      summary:
        "An agent's API key (Authorization) and a user's access token give a delegated token",
      tag: 'auth',
      auth: false,
      body: z.object({ userToken: z.string().max(4096) }),
      response: z.object({ token: z.string(), expiresIn: z.number() }),
    },
    async ({ request, body }) => {
      if (!auth || !deps.apiKeys) return missing();
      const key = await deps.apiKeys.verify(bearerOf(request) ?? '');
      return key.ok ? auth.delegate(key.value, body.userToken) : key;
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'POST',
      path: '/api/files/token',
      summary: 'A short-lived token for protected files',
      tag: 'files',
      auth: false,
      response: z.object({ token: z.string() }),
    },
    async ({ request }) => {
      if (!auth) return missing();
      const who = await identityOf(request, deps);
      if (!who.ok) return who;
      const token = await auth.fileToken(who.value.identity);
      return token.ok ? ok({ token: token.value }) : token;
    },
  );
  // The provider redirects the browser here; the page hands the code to the app window that opened it.
  app.get('/api/oauth2-redirect', { config: { auth: false } }, (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const data = JSON.stringify({
      code: typeof q['code'] === 'string' ? q['code'] : '',
      state: typeof q['state'] === 'string' ? q['state'] : '',
    });
    const safe = data.replace(/</g, '\\u003c');
    return reply
      .type('text/html')
      .header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'")
      .send(
        `<!doctype html><meta charset="utf-8"><title>Signing in…</title><script>if(window.opener){window.opener.postMessage(${safe},'*');window.close()}else{document.write('Return to the app to finish signing in.')}</script>`,
      );
  });
}
