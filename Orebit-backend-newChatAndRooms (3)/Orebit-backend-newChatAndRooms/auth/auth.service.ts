/**
 * The module's business-logic surface.
 *
 * README.md's convention gives each module a single `<name>.service.ts`. The auth
 * flow does not fit one file under the 500-line limit, so it is split by flow and
 * this file is what the convention's entry point became: the index of that split,
 * and the provider list built from it.
 *
 * It deliberately re-exports nothing. Every consumer — the controller, the guards,
 * the specs — imports the class it needs from `services/` directly, so a
 * re-export block here would be a second name for each service that nothing uses
 * and that could drift from the list below.
 *
 * The split is by *flow*, not by layer, so each file owns one user-visible journey
 * end to end:
 *
 *   services/registration.service.ts  the state machine: start → verify → referral →
 *                                     credentials → country
 *   services/login.service.ts         password login, email-OTP login, identifier resolution
 *   services/session.service.ts       mint / rotate / revoke, and "is this session live"
 *   services/password.service.ts      forgot and reset — also the only way a passwordless
 *                                     account ever gets a password
 *   services/oauth.service.ts         Google: authorization URL, callback, three outcomes
 *   services/credential.service.ts    hashing, policy, lockout — everything that touches a
 *                                     plaintext password, in one place
 *   services/blocklist.service.ts     "may this address use the product" — the one question
 *                                     signup, login and the OAuth callback all have to ask
 *   services/user.service.ts          account creation and identifier allocation, plus the
 *                                     profile read and update behind /auth/me
 *
 * `user.service.ts` is the one entry that is not a *flow*: it is the account
 * aggregate the flows above converge on. It lived in `src/user` until accounts
 * moved here, which is what let the two modules stop importing each other through
 * a pair of `forwardRef`s.
 *
 * Note there is deliberately no facade class here. The controller injects the
 * services it needs directly; a class whose every method forwarded to one of the
 * above would add a layer without adding a decision.
 */

import { BlocklistService } from './services/blocklist.service';
import { CredentialService } from './services/credential.service';
import { LoginService } from './services/login.service';
import { OauthService } from './services/oauth.service';
import { PasswordService } from './services/password.service';
import { RegistrationService } from './services/registration.service';
import { SessionService } from './services/session.service';
import { UserService } from './services/user.service';
import { RateLimitPolicyService } from './services/rate-limit-policy.service';

/** Every service provider, for auth.module.ts to register in one place. */
export const AUTH_SERVICES = [
  CredentialService,
  SessionService,
  RegistrationService,
  LoginService,
  PasswordService,
  OauthService,
  BlocklistService,
  UserService,
  RateLimitPolicyService,
] as const;
