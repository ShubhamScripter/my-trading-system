import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { OauthProvider } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { OAUTH_ADAPTERS, type OauthProviderAdapter } from './provider.port';

/**
 * Provider name to adapter, and the one place a provider can be refused.
 *
 * ─── Why the DTO now accepts all five providers ─────────────────────────────
 *
 * It used to accept only `GOOGLE`, on the reasoning that a validation error naming
 * the one working provider was more honest than a 502 from a missing adapter. That
 * reasoning was right and this replaces the mechanism rather than the intent:
 * `require` refuses an unconfigured provider with `oauth_provider_unsupported`, a
 * 400 that names the provider. So the wire contract no longer has to change when a
 * deployment gains credentials — the enum is the set of providers that EXIST, and
 * configuration decides which are OFFERED.
 *
 * That distinction matters for a staged rollout: staging can hold Apple credentials
 * and production not, from one build, with no branch and no schema difference.
 */
@Injectable()
export class OauthProviderRegistry implements OnModuleInit {
  private readonly logger = new Logger('OauthProviderRegistry');
  private readonly byProvider: ReadonlyMap<OauthProvider, OauthProviderAdapter>;

  constructor(@Inject(OAUTH_ADAPTERS) adapters: readonly OauthProviderAdapter[]) {
    const map = new Map<OauthProvider, OauthProviderAdapter>();
    for (const adapter of adapters) {
      if (map.has(adapter.provider)) {
        // A programming error, and fatal on purpose: two adapters for one provider
        // means the one that wins is decided by array order, and a login flow whose
        // verification logic depends on module registration order is not something
        // to discover in production.
        throw new Error(`duplicate oauth adapter registered for ${adapter.provider}`);
      }
      map.set(adapter.provider, adapter);
    }
    this.byProvider = map;
  }

  /**
   * Say at boot which providers this deployment actually offers.
   *
   * The same reasoning as `MailService`'s transport log: a provider silently absent
   * because one env var was misspelled looks identical, from the outside, to a
   * client bug. This makes it a line in the startup log instead.
   */
  onModuleInit(): void {
    const enabled: string[] = [];
    const present: string[] = [];

    for (const [provider, adapter] of this.byProvider) {
      (adapter.isConfigured() ? enabled : present).push(provider);
    }

    this.logger.log({ enabled, unconfigured: present }, 'oauth providers');

    if (enabled.length === 0) {
      this.logger.warn(
        'no oauth provider is configured — every "continue with…" request will be refused',
      );
    }
  }

  /**
   * The providers this deployment can actually complete a sign-in with.
   *
   * The same question `onModuleInit` logs at boot, asked at runtime. It exists for
   * the Settings screen, which has to render "available to link" — and a client
   * cannot derive that from the enum, because the enum is the set of providers that
   * EXIST while configuration decides which are OFFERED.
   *
   * Read through `OauthService.availableProviders` rather than by injecting this
   * class: `AuthModule` deliberately does not export the registry, so that
   * `OauthService` stays the only thing able to reach an adapter. See the note in
   * auth.module.ts.
   */
  enabled(): readonly OauthProvider[] {
    const offered: OauthProvider[] = [];
    for (const [provider, adapter] of this.byProvider) {
      if (adapter.isConfigured()) offered.push(provider);
    }
    return offered;
  }

  /**
   * The adapter for a provider, or a refusal.
   *
   * One error for both "no adapter exists" and "credentials are absent". They are
   * the same fact from the caller's side — this deployment cannot complete a sign-in
   * with that provider — and telling them apart would report which providers are
   * built but unconfigured, which is deployment shape rather than anything a client
   * can act on.
   */
  require(provider: OauthProvider): OauthProviderAdapter {
    const adapter = this.byProvider.get(provider);

    if (adapter === undefined || !adapter.isConfigured()) {
      throw new ProblemException({
        type: ERR.OAUTH_PROVIDER_UNSUPPORTED,
        detail: `${provider} sign-in is not configured on this deployment.`,
      });
    }

    return adapter;
  }
}
