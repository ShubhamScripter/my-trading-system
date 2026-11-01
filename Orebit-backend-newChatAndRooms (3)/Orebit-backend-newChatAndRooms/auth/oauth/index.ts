import type { Provider } from '@nestjs/common';
import { AppleAdapter } from './apple.adapter';
import { FacebookAdapter } from './facebook.adapter';
import { GoogleAdapter } from './google.adapter';
import { OAUTH_ADAPTERS } from './provider.port';
import { OauthProviderRegistry } from './registry';
import { TelegramAdapter } from './telegram.adapter';
import { XAdapter } from './x.adapter';

export { OauthProviderRegistry } from './registry';
export { OAUTH_ADAPTERS } from './provider.port';
export type {
  AuthorizationRequest,
  EmailAvailability,
  OauthFlow,
  OauthProviderAdapter,
  ProviderCapabilities,
  VerificationRequest,
} from './provider.port';

/**
 * Every provider adapter, and the registry that resolves one.
 *
 * The adapters are registered as ordinary providers AND collected into the
 * `OAUTH_ADAPTERS` array the registry injects. Both, rather than only the array,
 * because Nest has to construct each one — `GoogleAdapter` builds an `OAuth2Client`
 * in its constructor — and `useFactory` is what lets the registry receive them as a
 * list without knowing their names.
 *
 * Adding a provider is one import and two lines in this file. Nothing in
 * `OauthService` changes, which is the property the port exists to buy.
 */
export const OAUTH_PROVIDERS: Provider[] = [
  GoogleAdapter,
  AppleAdapter,
  FacebookAdapter,
  XAdapter,
  TelegramAdapter,
  {
    provide: OAUTH_ADAPTERS,
    useFactory: (
      google: GoogleAdapter,
      apple: AppleAdapter,
      facebook: FacebookAdapter,
      x: XAdapter,
      telegram: TelegramAdapter,
    ) => [google, apple, facebook, x, telegram],
    inject: [GoogleAdapter, AppleAdapter, FacebookAdapter, XAdapter, TelegramAdapter],
  },
  OauthProviderRegistry,
];
