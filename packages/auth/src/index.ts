/**
 * @mindlog/auth — end-user authentication for full-stack mode (PLAN 16.4,
 * ADR-0035): argon2id passwords, HS256 JWTs, identities, rate limits, and the
 * opt-in mailer and OAuth2 client.
 */
export { hashPassword, verifyPassword } from './password.js';
export type { TokenClaims, TokenType, UnverifiedJwt } from './jwt.js';
export { readJwt, signJwt, verifyJwt } from './jwt.js';
export type { Identity } from './identity.js';
export { ANONYMOUS, accessOf, actorOf, principalOf } from './identity.js';
export type { Access, Action, Decision, PolicyRow, Resource, Role } from './policy.js';
export { ACTIONS, ROLES, decide, matchesScope } from './policy.js';
export { RateLimiter } from './rate-limit.js';
export { otpCode, randomSecret, recordId, sha256 } from './secrets.js';
export type { MailMessage, Mailer, SmtpOptions } from './mailer.js';
export { ConsoleMailer, SmtpMailer } from './mailer.js';
export type { ExternalUser, Fetch, OAuth2Provider, ProviderSettings } from './oauth2.js';
export { authorizeUrl, discoverOidc, exchangeCode, github, google, pkce } from './oauth2.js';
