import { createHash, randomBytes } from 'node:crypto';
import { err, mindlogError, ok } from '@mindlog/core';
import type { MindlogError, Result } from '@mindlog/core';

/** An identity provider for the opt-in OAuth2 sign-in (ADR-0035). */
export interface OAuth2Provider {
  readonly name: string;
  readonly authUrl: string;
  readonly tokenUrl: string;
  readonly userInfoUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
}

/** The user the provider vouches for. */
export interface ExternalUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  /** Whether the provider verified the email. */
  readonly verified: boolean;
}

export interface ProviderSettings {
  readonly clientId: string;
  readonly clientSecret: string;
}

export const google = (s: ProviderSettings): OAuth2Provider => ({
  name: 'google',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  scopes: ['openid', 'email', 'profile'],
  ...s,
});

export const github = (s: ProviderSettings): OAuth2Provider => ({
  name: 'github',
  authUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  userInfoUrl: 'https://api.github.com/user',
  scopes: ['read:user', 'user:email'],
  ...s,
});

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A generic OpenID Connect provider from its discovery document. */
export async function discoverOidc(
  name: string,
  issuer: string,
  s: ProviderSettings,
  fetchImpl: Fetch = fetch,
): Promise<Result<OAuth2Provider, MindlogError>> {
  try {
    const res = await fetchImpl(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!res.ok)
      return err(mindlogError('UNAVAILABLE', `OIDC discovery failed: ${String(res.status)}`));
    const doc = (await res.json()) as Record<string, unknown>;
    const [authUrl, tokenUrl, userInfoUrl] = [
      doc['authorization_endpoint'],
      doc['token_endpoint'],
      doc['userinfo_endpoint'],
    ];
    if (
      typeof authUrl !== 'string' ||
      typeof tokenUrl !== 'string' ||
      typeof userInfoUrl !== 'string'
    ) {
      return err(mindlogError('UNAVAILABLE', 'the OIDC discovery document lacks endpoints'));
    }
    return ok({
      name,
      authUrl,
      tokenUrl,
      userInfoUrl,
      scopes: ['openid', 'email', 'profile'],
      ...s,
    });
  } catch (e) {
    return err(
      mindlogError(
        'UNAVAILABLE',
        `OIDC discovery failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

/** A PKCE pair (RFC 7636, S256). */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(
  p: OAuth2Provider,
  o: { state: string; challenge: string; redirectUri: string },
): string {
  const url = new URL(p.authUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: o.redirectUri,
    scope: p.scopes.join(' '),
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

/** Trades the code for a token (with the PKCE verifier) and reads the user from the provider. */
export async function exchangeCode(
  p: OAuth2Provider,
  o: { code: string; verifier: string; redirectUri: string },
  fetchImpl: Fetch = fetch,
): Promise<Result<ExternalUser, MindlogError>> {
  try {
    const tokenRes = await fetchImpl(p.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: o.code,
        redirect_uri: o.redirectUri,
        client_id: p.clientId,
        client_secret: p.clientSecret,
        code_verifier: o.verifier,
      }).toString(),
    });
    const token = (await tokenRes.json()) as Record<string, unknown>;
    const access = str(token['access_token']);
    if (!tokenRes.ok || access === '')
      return err(mindlogError('INVALID_CREDENTIALS', 'the provider refused the code'));
    const auth = { authorization: `Bearer ${access}`, accept: 'application/json' };
    const info = (await (await fetchImpl(p.userInfoUrl, { headers: auth })).json()) as Record<
      string,
      unknown
    >;
    let email = str(info['email']);
    let verified = info['email_verified'] === true;
    if (p.name === 'github') {
      // GitHub keeps private emails behind /user/emails.
      const emails = (await (
        await fetchImpl(`${p.userInfoUrl}/emails`, { headers: auth })
      ).json());
      const primary = Array.isArray(emails)
        ? (emails as Record<string, unknown>[]).find(
            (e) => e['primary'] === true && e['verified'] === true,
          )
        : undefined;
      if (primary) {
        email = str(primary['email']);
        verified = true;
      }
    }
    const id = str(info['sub']) || str(info['id']);
    if (id === '') return err(mindlogError('UNAVAILABLE', 'the provider returned no user id'));
    return ok({
      id,
      email: email.toLowerCase(),
      name: str(info['name']) || str(info['login']),
      verified,
    });
  } catch (e) {
    return err(
      mindlogError(
        'UNAVAILABLE',
        `OAuth2 exchange failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}
