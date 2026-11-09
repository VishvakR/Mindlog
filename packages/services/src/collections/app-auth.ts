import type { Clock, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { Identity, Mailer, OAuth2Provider, TokenClaims, TokenType } from '@mindlog/auth';
import {
  authorizeUrl,
  exchangeCode,
  otpCode,
  pkce,
  randomSecret,
  readJwt,
  sha256,
  signJwt,
  verifyJwt,
  verifyPassword,
} from '@mindlog/auth';
import type { CollectionInput, CollectionSchema } from '@mindlog/collections';
import type { Expr } from '@mindlog/rules';
import type { ApiKeyIdentity } from '../admin/api-keys.js';
import type { KvService } from '../kv/kv-service.js';
import type { RawRecord } from './collection-ranges.js';
import type { CollectionService } from './collection-service.js';
import { JwtKeySet } from './key-set.js';
import type { RecordView, RequestContext } from './record-reader.js';
import { callerOf, ruleRecord } from './record-reader.js';

export interface AppAuthDeps {
  readonly collections: CollectionService;
  readonly kv: KvService;
  readonly clock: Clock;
  /** Opt-in OTP, verification and reset mail (ADR-0035); absent turns those flows off. */
  readonly mailer?: Mailer;
  /** Opt-in OAuth2 providers by name. */
  readonly providers?: ReadonlyMap<string, () => Promise<Result<OAuth2Provider, MindlogError>>>;
  /** Public base URL of the app, used in verification and reset mail links. */
  readonly appUrl?: string;
  readonly accessTtlS?: number;
}

export interface AuthResponse {
  readonly token: string;
  readonly refreshToken: string;
  readonly record: RecordView;
}

const TTL_S: Readonly<Record<TokenType, number>> = {
  access: 900,
  delegated: 900,
  file: 120,
  verify: 7 * 86_400,
  reset: 1800,
  oauth2: 600,
};
const REFRESH_TTL_MS = 30 * 86_400_000;
const OTP_ATTEMPTS = 5;

/** System collections of auth (ADR-0035): superusers only, created on first use per tenant. */
const SYSTEM: Readonly<Record<string, CollectionInput>> = {
  _sessions: {
    name: '_sessions',
    fields: [
      { name: 'collection', type: 'text' },
      { name: 'record', type: 'text' },
      { name: 'tokenHash', type: 'text' },
      { name: 'keyHash', type: 'text' },
      { name: 'expires', type: 'date' },
    ],
    indexes: [{ name: 'by_hash', fields: ['tokenHash'], unique: true }],
  },
  _otps: {
    name: '_otps',
    fields: [
      { name: 'collection', type: 'text' },
      { name: 'record', type: 'text' },
      { name: 'codeHash', type: 'text' },
      { name: 'expires', type: 'date' },
      { name: 'attempts', type: 'number' },
    ],
  },
  _externalAuths: {
    name: '_externalAuths',
    fields: [
      { name: 'collection', type: 'text' },
      { name: 'record', type: 'text' },
      { name: 'provider', type: 'text' },
      { name: 'providerId', type: 'text' },
    ],
    indexes: [
      { name: 'by_provider', fields: ['collection', 'provider', 'providerId'], unique: true },
    ],
  },
};

const unauthenticated = () =>
  err(mindlogError('UNAUTHENTICATED', 'The request requires valid record authorization token.'));
const invalidLogin = () => err(mindlogError('INVALID_ARGUMENT', 'Failed to authenticate.'));
const disabled = (what: string) =>
  err(mindlogError('INVALID_ARGUMENT', `${what} is not enabled for this collection.`));

const tokenKeyOf = (r: RawRecord): string =>
  typeof r.data['tokenKey'] === 'string' ? r.data['tokenKey'] : '';

/** `field = value` built as a tree, so values never need quoting. */
export function eq(...pairs: [string, string][]): Expr {
  const leaf = ([field, value]: [string, string]): Expr => ({
    kind: 'compare',
    op: '=',
    left: { kind: 'ident', root: { kind: 'record' }, path: [field], from: 0, to: 0 },
    right: { kind: 'literal', value, from: 0, to: 0 },
    from: 0,
    to: 0,
  });
  return pairs.map(leaf).reduce((a, b) => ({ kind: 'and', left: a, right: b, from: 0, to: 0 }));
}

/**
 * End-user auth for auth collections (PLAN 16.4, ADR-0035): password sign-in
 * with access and refresh tokens, delegated agent tokens, and the opt-in OTP,
 * verification, password reset and OAuth2 flows.
 */
export class AppAuthService {
  readonly keys: JwtKeySet;

  constructor(private readonly d: AppAuthDeps) {
    this.keys = new JwtKeySet(d.kv);
  }

  #nowS = (): number => Math.floor(Number(this.d.clock.now()) / 1000);
  #system = (tenant: string): RequestContext => ({
    identity: { kind: 'superuser', email: 'system:auth' },
    tenant,
  });

  async #schema(
    tenant: string,
    collection: string,
  ): Promise<Result<CollectionSchema, MindlogError>> {
    const found = await this.d.collections.catalog.get(callerOf(this.#system(tenant)), collection);
    if (!found.ok) return found;
    if (found.value?.schema.type !== 'auth')
      return err(mindlogError('NOT_FOUND', `Missing auth collection ${collection}.`));
    return ok(found.value.schema);
  }

  /** Creates a system collection the first time a tenant needs it. */
  async #ensure(tenant: string, name: keyof typeof SYSTEM): Promise<Result<void, MindlogError>> {
    const ctx = this.#system(tenant);
    const found = await this.d.collections.catalog.get(callerOf(ctx), name);
    if (!found.ok) return found;
    if (found.value) return ok(undefined);
    const made = await this.d.collections.saveCollection(ctx, SYSTEM[name] ?? { name });
    this.d.collections.catalog.invalidate(tenant);
    return made.ok || made.error.code === 'ALREADY_EXISTS' || made.error.code === 'CONFLICT'
      ? ok(undefined)
      : made;
  }

  async #find(
    tenant: string,
    collection: string,
    expr: Expr,
  ): Promise<Result<RawRecord | undefined, MindlogError>> {
    const reader = await this.d.collections.reader(this.#system(tenant));
    if (!reader.ok) return reader;
    const found = await reader.value.matching(collection, expr, 1);
    return found.ok ? ok(found.value[0]) : found;
  }

  async #record(
    tenant: string,
    collection: string,
    id: string,
  ): Promise<Result<RawRecord | undefined, MindlogError>> {
    const reader = await this.d.collections.reader(this.#system(tenant));
    if (!reader.ok) return reader;
    const found = await reader.value.get(collection, [id]);
    return found.ok ? ok(found.value[0]) : found;
  }

  /** Signs a token for a record (or for no record, with `user` undefined). */
  async sign(
    claims: Omit<TokenClaims, 'iat' | 'exp'>,
    user: RawRecord | undefined,
  ): Promise<Result<string, MindlogError>> {
    const key = await this.keys.current();
    if (!key.ok) return key;
    const iat = this.#nowS();
    const tokenKey = typeof user?.data['tokenKey'] === 'string' ? user.data['tokenKey'] : '';
    return ok(
      signJwt(
        { ...claims, iat, exp: iat + TTL_S[claims.typ] },
        key.value.kid,
        key.value.secret + tokenKey,
      ),
    );
  }

  /** Checks a token of one of `types` and returns its claims and record. */
  async check(
    token: string,
    types: readonly TokenType[],
  ): Promise<Result<{ claims: TokenClaims; record: RawRecord | undefined }, MindlogError>> {
    const read = readJwt(token);
    if (!read || !types.includes(read.claims.typ)) return unauthenticated();
    const secret = await this.keys.secret(read.kid);
    if (secret === undefined) return unauthenticated();
    const { claims } = read;
    let record: RawRecord | undefined;
    if (claims.sub !== '') {
      const found = await this.#record(claims.ten, claims.col, claims.sub);
      if (!found.ok) return found;
      record = found.value;
      if (!record) return unauthenticated();
    }
    const tokenKey = typeof record?.data['tokenKey'] === 'string' ? record.data['tokenKey'] : '';
    return verifyJwt(token, secret + tokenKey, this.#nowS())
      ? ok({ claims, record })
      : unauthenticated();
  }

  /** The identity of an access or delegated token (the HTTP bearer). */
  async authenticate(token: string): Promise<Result<Identity, MindlogError>> {
    const checked = await this.check(token, ['access', 'delegated']);
    if (!checked.ok) return checked;
    const { claims } = checked.value;
    return ok(
      claims.typ === 'delegated'
        ? {
            kind: 'delegated',
            tenant: claims.ten,
            collection: claims.col,
            id: claims.sub,
            actor: claims.act ?? '',
          }
        : { kind: 'record', tenant: claims.ten, collection: claims.col, id: claims.sub },
    );
  }

  async #respond(
    tenant: string,
    collection: string,
    user: RawRecord,
  ): Promise<Result<AuthResponse, MindlogError>> {
    const hooks = this.d.collections.hooks;
    if (hooks?.has('onAuth', collection, 'before')) {
      const record = ruleRecord(collection, user);
      const ran = await hooks.run({ event: 'onAuth', collection, phase: 'before', record });
      if (!ran.ok) return ran;
    }
    const token = await this.sign(
      { sub: user.id, col: collection, ten: tenant, typ: 'access' },
      user,
    );
    if (!token.ok) return token;
    const ensured = await this.#ensure(tenant, '_sessions');
    if (!ensured.ok) return ensured;
    const refreshToken = randomSecret(32);
    const stored = await this.d.collections.create(this.#system(tenant), '_sessions', {
      collection,
      record: user.id,
      tokenHash: sha256(refreshToken),
      keyHash: sha256(tokenKeyOf(user)),
      expires: Number(this.d.clock.now()) + REFRESH_TTL_MS,
    });
    if (!stored.ok) return stored;
    const reader = await this.d.collections.reader({
      identity: { kind: 'record', tenant, collection, id: user.id },
      tenant,
    });
    if (!reader.ok) return reader;
    return ok({ token: token.value, refreshToken, record: reader.value.present(collection, user) });
  }

  async authWithPassword(
    tenant: string,
    collection: string,
    identity: string,
    password: string,
  ): Promise<Result<AuthResponse, MindlogError>> {
    const schema = await this.#schema(tenant, collection);
    if (!schema.ok) return schema;
    if (schema.value.auth?.password.enabled === false) return disabled('Password sign-in');
    const user = await this.#find(tenant, collection, eq(['email', identity.trim().toLowerCase()]));
    if (!user.ok) return user;
    const hash =
      typeof user.value?.data['password'] === 'string' ? user.value.data['password'] : '';
    // Unknown users verify against a dummy hash, so both take as long.
    const valid = await verifyPassword(user.value ? hash : '', password);
    if (!user.value || !valid) return invalidLogin();
    if (schema.value.auth?.requireVerified === true && user.value.data['verified'] !== true) {
      return err(mindlogError('PERMISSION_DENIED', 'Please verify your email first.'));
    }
    return this.#respond(tenant, collection, user.value);
  }

  /** A new token from a valid one (PocketBase `auth-refresh`) or from a refresh token, which rotates. */
  async refresh(
    tenant: string,
    collection: string,
    input: { token?: string; refreshToken?: string },
  ): Promise<Result<AuthResponse | { token: string; record: RecordView }, MindlogError>> {
    if (input.refreshToken !== undefined) {
      const ensured = await this.#ensure(tenant, '_sessions');
      if (!ensured.ok) return ensured;
      const session = await this.#find(
        tenant,
        '_sessions',
        eq(['tokenHash', sha256(input.refreshToken)]),
      );
      if (!session.ok) return session;
      const s = session.value;
      if (!s || s.data['collection'] !== collection) return unauthenticated();
      await this.d.collections.delete(this.#system(tenant), '_sessions', s.id);
      const user = await this.#record(tenant, collection, String(s.data['record']));
      if (!user.ok) return user;
      const expired =
        Date.parse(String(s.data['expires']).replace(' ', 'T')) < Number(this.d.clock.now());
      // A changed tokenKey (new password, reset) ends every session.
      if (!user.value || expired || sha256(tokenKeyOf(user.value)) !== s.data['keyHash'])
        return unauthenticated();
      return this.#respond(tenant, collection, user.value);
    }
    const checked = await this.check(input.token ?? '', ['access']);
    if (!checked.ok) return checked;
    const { claims, record } = checked.value;
    if (!record || claims.col !== collection || claims.ten !== tenant) return unauthenticated();
    const token = await this.sign(
      { sub: record.id, col: collection, ten: tenant, typ: 'access' },
      record,
    );
    if (!token.ok) return token;
    const reader = await this.d.collections.reader({
      identity: { kind: 'record', tenant, collection, id: record.id },
      tenant,
    });
    return reader.ok
      ? ok({ token: token.value, record: reader.value.present(collection, record) })
      : reader;
  }

  /**
   * An agent's API key plus a user's access token give a delegated token
   * (ADR-0035): rules evaluate as the user, commands record the agent.
   */
  async delegate(
    key: Pick<ApiKeyIdentity, 'id' | 'tenant' | 'user'>,
    userToken: string,
  ): Promise<Result<{ token: string; expiresIn: number }, MindlogError>> {
    const checked = await this.check(userToken, ['access']);
    if (!checked.ok) return checked;
    const { claims, record } = checked.value;
    if (claims.ten !== key.tenant)
      return err(mindlogError('PERMISSION_DENIED', 'the API key belongs to another tenant'));
    if (key.user !== undefined && key.user !== claims.sub) {
      return err(mindlogError('PERMISSION_DENIED', `this API key is limited to user ${key.user}`));
    }
    const token = await this.sign(
      { sub: claims.sub, col: claims.col, ten: claims.ten, typ: 'delegated', act: key.id },
      record,
    );
    return token.ok ? ok({ token: token.value, expiresIn: TTL_S.delegated }) : token;
  }

  /** A short-lived token for protected files, signed for the requester (PLAN 16.5). */
  async fileToken(identity: Identity): Promise<Result<string, MindlogError>> {
    if (identity.kind !== 'record' && identity.kind !== 'delegated') {
      return err(mindlogError('UNAUTHENTICATED', 'File tokens are for authenticated records.'));
    }
    const user = await this.#record(identity.tenant, identity.collection, identity.id);
    if (!user.ok) return user;
    return this.sign(
      { sub: identity.id, col: identity.collection, ten: identity.tenant, typ: 'file' },
      user.value,
    );
  }

  async authMethods(tenant: string, collection: string, redirectUrl?: string) {
    const schema = await this.#schema(tenant, collection);
    if (!schema.ok) return schema;
    const auth = schema.value.auth;
    const providers: { name: string; authUrl: string; state: string }[] = [];
    if (auth?.oauth2.enabled === true && redirectUrl !== undefined) {
      for (const name of auth.oauth2.providers) {
        const provider = await this.d.providers?.get(name)?.();
        if (!provider?.ok) continue;
        const { verifier, challenge } = pkce();
        const state = await this.sign(
          {
            sub: '',
            col: collection,
            ten: tenant,
            typ: 'oauth2',
            dat: { p: name, v: verifier, r: redirectUrl },
          },
          undefined,
        );
        if (!state.ok) return state;
        providers.push({
          name,
          state: state.value,
          authUrl: authorizeUrl(provider.value, {
            state: state.value,
            challenge,
            redirectUri: redirectUrl,
          }),
        });
      }
    }
    return ok({
      password: { enabled: auth?.password.enabled !== false },
      otp: { enabled: auth?.otp.enabled === true && this.d.mailer !== undefined },
      oauth2: { enabled: providers.length > 0, providers },
    });
  }

  // ---- opt-in flows ----

  async requestOtp(
    tenant: string,
    collection: string,
    email: string,
  ): Promise<Result<{ otpId: string }, MindlogError>> {
    const schema = await this.#schema(tenant, collection);
    if (!schema.ok) return schema;
    const options = schema.value.auth?.otp;
    if (options?.enabled !== true || !this.d.mailer) return disabled('OTP sign-in');
    const ensured = await this.#ensure(tenant, '_otps');
    if (!ensured.ok) return ensured;
    const user = await this.#find(tenant, collection, eq(['email', email.trim().toLowerCase()]));
    if (!user.ok) return user;
    const code = otpCode(options.length);
    const otp = await this.d.collections.create(this.#system(tenant), '_otps', {
      collection,
      record: user.value?.id ?? '',
      codeHash: sha256(code),
      expires: Number(this.d.clock.now()) + options.durationS * 1000,
      attempts: 0,
    });
    if (!otp.ok) return otp;
    // An unknown email gets an otpId too, so the answer does not reveal who has an account.
    if (user.value) {
      const sent = await this.d.mailer.send({
        to: String(user.value.data['email']),
        subject: 'Your sign-in code',
        text: `Your code is ${code}. It expires in ${String(Math.round(options.durationS / 60))} minutes.`,
      });
      if (!sent.ok) return sent;
    }
    return ok({ otpId: otp.value.raw.id });
  }

  async authWithOtp(
    tenant: string,
    collection: string,
    otpId: string,
    code: string,
  ): Promise<Result<AuthResponse, MindlogError>> {
    const schema = await this.#schema(tenant, collection);
    if (!schema.ok) return schema;
    if (schema.value.auth?.otp.enabled !== true || !this.d.mailer) return disabled('OTP sign-in');
    const sys = this.#system(tenant);
    const otp = await this.#record(tenant, '_otps', otpId);
    if (!otp.ok) return otp;
    const o = otp.value;
    if (!o || o.data['collection'] !== collection || o.data['record'] === '') return invalidLogin();
    const expired =
      Date.parse(String(o.data['expires']).replace(' ', 'T')) < Number(this.d.clock.now());
    const attempts = Number(o.data['attempts']);
    if (expired || attempts >= OTP_ATTEMPTS) {
      await this.d.collections.delete(sys, '_otps', o.id);
      return invalidLogin();
    }
    if (sha256(code) !== o.data['codeHash']) {
      await this.d.collections.update(sys, '_otps', o.id, { 'attempts+': 1 });
      return invalidLogin();
    }
    await this.d.collections.delete(sys, '_otps', o.id);
    // Receiving the code proves the email.
    const user = await this.d.collections.update(sys, collection, String(o.data['record']), {
      verified: true,
    });
    return user.ok ? this.#respond(tenant, collection, user.value.raw) : user;
  }

  async #mailToken(
    tenant: string,
    collection: string,
    email: string,
    typ: 'verify' | 'reset',
  ): Promise<Result<void, MindlogError>> {
    if (!this.d.mailer)
      return disabled(typ === 'verify' ? 'Email verification' : 'Password reset by email');
    const schema = await this.#schema(tenant, collection);
    if (!schema.ok) return schema;
    const user = await this.#find(tenant, collection, eq(['email', email.trim().toLowerCase()]));
    if (!user.ok) return user;
    // No error for unknown emails: the answer must not reveal who has an account.
    if (!user.value || (typ === 'verify' && user.value.data['verified'] === true))
      return ok(undefined);
    const token = await this.sign(
      { sub: user.value.id, col: collection, ten: tenant, typ },
      user.value,
    );
    if (!token.ok) return token;
    const path = typ === 'verify' ? 'confirm-verification' : 'confirm-password-reset';
    const link = `${this.d.appUrl ?? ''}/_/#/auth/${path}/${token.value}`;
    const subject = typ === 'verify' ? 'Verify your email' : 'Reset your password';
    return this.d.mailer.send({
      to: String(user.value.data['email']),
      subject,
      text: `${subject}: ${link}\n\nOr use this token: ${token.value}`,
    });
  }

  requestVerification(
    tenant: string,
    collection: string,
    email: string,
  ): Promise<Result<void, MindlogError>> {
    return this.#mailToken(tenant, collection, email, 'verify');
  }

  requestPasswordReset(
    tenant: string,
    collection: string,
    email: string,
  ): Promise<Result<void, MindlogError>> {
    return this.#mailToken(tenant, collection, email, 'reset');
  }

  async confirmVerification(
    tenant: string,
    collection: string,
    token: string,
  ): Promise<Result<void, MindlogError>> {
    const checked = await this.check(token, ['verify']);
    if (
      !checked.ok ||
      checked.value.claims.ten !== tenant ||
      checked.value.claims.col !== collection
    )
      return invalidLogin();
    const done = await this.d.collections.update(
      this.#system(tenant),
      collection,
      checked.value.claims.sub,
      { verified: true },
    );
    return done.ok ? ok(undefined) : done;
  }

  async confirmPasswordReset(
    tenant: string,
    collection: string,
    input: { token: string; password: string; passwordConfirm: string },
  ): Promise<Result<void, MindlogError>> {
    const checked = await this.check(input.token, ['reset']);
    if (
      !checked.ok ||
      checked.value.claims.ten !== tenant ||
      checked.value.claims.col !== collection
    )
      return invalidLogin();
    // The new password changes tokenKey, so this token and every session end.
    const done = await this.d.collections.update(
      this.#system(tenant),
      collection,
      checked.value.claims.sub,
      {
        password: input.password,
        passwordConfirm: input.passwordConfirm,
      },
    );
    return done.ok ? ok(undefined) : done;
  }

  async authWithOAuth2(
    tenant: string,
    collection: string,
    input: { provider: string; code: string; state: string },
  ): Promise<Result<AuthResponse, MindlogError>> {
    const schema = await this.#schema(tenant, collection);
    if (!schema.ok) return schema;
    if (schema.value.auth?.oauth2.enabled !== true) return disabled('OAuth2 sign-in');
    const state = await this.check(input.state, ['oauth2']);
    const dat = state.ok ? state.value.claims.dat : undefined;
    if (
      !state.ok ||
      state.value.claims.col !== collection ||
      state.value.claims.ten !== tenant ||
      dat?.['p'] !== input.provider
    ) {
      return invalidLogin();
    }
    const provider = await this.d.providers?.get(input.provider)?.();
    if (!provider?.ok) return disabled(`Provider ${input.provider}`);
    const external = await exchangeCode(provider.value, {
      code: input.code,
      verifier: dat['v'] ?? '',
      redirectUri: dat['r'] ?? '',
    });
    if (!external.ok) return external;
    const ensured = await this.#ensure(tenant, '_externalAuths');
    if (!ensured.ok) return ensured;
    const sys = this.#system(tenant);
    const link = await this.#find(
      tenant,
      '_externalAuths',
      eq(
        ['collection', collection],
        ['provider', input.provider],
        ['providerId', external.value.id],
      ),
    );
    if (!link.ok) return link;
    let user: RawRecord | undefined;
    if (link.value) {
      const found = await this.#record(tenant, collection, String(link.value.data['record']));
      if (!found.ok) return found;
      user = found.value;
    }
    if (!user && external.value.email !== '' && external.value.verified) {
      const byEmail = await this.#find(tenant, collection, eq(['email', external.value.email]));
      if (!byEmail.ok) return byEmail;
      user = byEmail.value;
    }
    if (!user) {
      const password = randomSecret(24);
      const made = await this.d.collections.create(sys, collection, {
        email: external.value.email,
        password,
        passwordConfirm: password,
        verified: external.value.verified,
      });
      if (!made.ok) return made;
      user = made.value.raw;
    }
    if (!link.value) {
      const linked = await this.d.collections.create(sys, '_externalAuths', {
        collection,
        record: user.id,
        provider: input.provider,
        providerId: external.value.id,
      });
      if (!linked.ok && linked.error.code !== 'ALREADY_EXISTS') return linked;
    }
    return this.#respond(tenant, collection, user);
  }
}
