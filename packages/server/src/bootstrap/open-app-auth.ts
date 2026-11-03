import type { Clock, Logger, MindlogConfig, MindlogError, Result } from '@mindlog/core';
import type { Mailer, OAuth2Provider } from '@mindlog/auth';
import { ConsoleMailer, SmtpMailer, discoverOidc, github, google } from '@mindlog/auth';
import type { CollectionService, KvService } from '@mindlog/services';
import { AppAuthService } from '@mindlog/services';
import { ok } from '@mindlog/core';

/** The opt-in mailer (ADR-0035): none unless `mail.mode` turns it on. */
function openMailer(config: MindlogConfig, logger: Logger): Mailer | undefined {
  const m = config.mail;
  if (m.mode === 'console') return new ConsoleMailer(logger);
  if (m.mode !== 'smtp') return undefined;
  return new SmtpMailer({
    host: m.host,
    port: m.port,
    tls: m.tls,
    requireTls: m.requireTls,
    from: m.from,
    timeoutMs: 10_000,
    ...(m.username === undefined ? {} : { username: m.username }),
    ...(m.password === undefined ? {} : { password: m.password }),
  });
}

/** Configured OAuth2 providers; OIDC issuers are discovered on first use and kept. */
function openProviders(
  config: MindlogConfig,
): Map<string, () => Promise<Result<OAuth2Provider, MindlogError>>> {
  const out = new Map<string, () => Promise<Result<OAuth2Provider, MindlogError>>>();
  for (const p of config.auth.oauth2) {
    const settings = { clientId: p.clientId, clientSecret: p.clientSecret };
    if (p.issuer === undefined && (p.name === 'google' || p.name === 'github')) {
      const provider = p.name === 'google' ? google(settings) : github(settings);
      out.set(p.name, () => Promise.resolve(ok(provider)));
      continue;
    }
    let found: Promise<Result<OAuth2Provider, MindlogError>> | undefined;
    out.set(p.name, async () => {
      found ??= discoverOidc(p.name, p.issuer ?? '', settings);
      const result = await found;
      if (!result.ok) found = undefined;
      return result;
    });
  }
  return out;
}

/** End-user auth for full-stack mode (PLAN 16.4). */
export function openAppAuth(deps: {
  readonly config: MindlogConfig;
  readonly collections: CollectionService;
  readonly kv: KvService;
  readonly clock: Clock;
  readonly logger: Logger;
}): AppAuthService {
  const mailer = openMailer(deps.config, deps.logger);
  return new AppAuthService({
    collections: deps.collections,
    kv: deps.kv,
    clock: deps.clock,
    providers: openProviders(deps.config),
    appUrl: deps.config.collections.appUrl,
    ...(mailer ? { mailer } : {}),
  });
}
