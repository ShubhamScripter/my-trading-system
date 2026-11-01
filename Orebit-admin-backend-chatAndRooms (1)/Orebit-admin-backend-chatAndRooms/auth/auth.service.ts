import { CredentialService } from './services/credential.service';
import { LoginService } from './services/login.service';
import { MfaService } from './services/mfa.service';
import { SessionService } from './services/session.service';

/**
 * The service barrel.
 *
 * `AUTH_SERVICES` is what auth.module.ts registers, so adding a service is one
 * edit here rather than two that can disagree.
 *
 * ─── The dependency shape, which is a security property ─────────────────────
 *
 * The edges between these are deliberately one-way:
 *
 *   LoginService  →  MfaService  →  SessionService
 *
 * `LoginService` does NOT inject `SessionService`. It cannot mint a session even
 * by accident, which is what makes "a password and an email code are not enough"
 * structural rather than a rule in a review checklist. Adding that constructor
 * parameter would be visible in a diff, and should be refused in one.
 */
export const AUTH_SERVICES = [
  CredentialService,
  SessionService,
  MfaService,
  LoginService,
] as const;

export { CredentialService } from './services/credential.service';
export { LoginService, type ResolvedAttempt } from './services/login.service';
export { MfaService } from './services/mfa.service';
export { SessionService } from './services/session.service';
