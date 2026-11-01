import { Logger } from '@nestjs/common';
import type { Passkey } from '@prisma/client';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { config } from '../config';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import { policy } from '../../auth/limits';

/**
 * WebAuthn, wrapped.
 *
 * Ported from Orebit-admin-backend/auth/security/passkey.ts. The differences are
 * the origin (`config.webauthnOrigin`, derived from `WEB_APP_URL`), the model name,
 * and the user-verification decision below, which lands differently here than it
 * did there.
 *
 * ─── Why a dependency here and not for TOTP ─────────────────────────────────
 *
 * `totp.ts` implements RFC 6238 by hand because it is sixty lines with published
 * test vectors. WebAuthn is the opposite trade: verification means CBOR decoding,
 * COSE key parsing, attestation-statement validation across half a dozen formats,
 * and a signature check whose failure modes are silent. That is exactly the code
 * you do not want to own, so `@simplewebauthn/server` owns it.
 *
 * What this file owns instead is the part that is ours: which origin and RP ID we
 * demand, how a challenge is bound to a ceremony, and the shape our database
 * stores. Everything crosses that boundary through these four functions, so no
 * service imports the library directly and swapping it stays a one-file job.
 *
 * ─── The two configuration values that break every passkey if changed ──────
 *
 * `rpID` is the registrable domain and `expectedOrigin` is the exact URL the
 * browser was on. A passkey is cryptographically bound to the RP ID it was
 * registered under, so changing `WEBAUTHN_RP_ID` does not migrate anything — it
 * silently invalidates every credential already enrolled. Treat it as permanent
 * per environment. The origin is derived from `WEB_APP_URL` rather than configured
 * separately, so the two cannot drift apart.
 */

const logger = new Logger('Passkey');

/** Which ceremony a stored challenge belongs to. */
export type PasskeyMode = 'register' | 'authenticate';

/**
 * What a WebAuthn challenge record holds while it waits in Redis.
 *
 * `mode` is the load-bearing field. It is written by the server when the challenge
 * is issued and read back at verification, which is what allows ONE verify step to
 * serve both ceremonies without letting a caller pick which verification path runs.
 * A client-supplied mode would let someone holding a `loginId` ask for the
 * registration path and enroll a passkey of their own onto a half-authenticated
 * sign-in — i.e. take over the account with a stolen password alone.
 */
export interface PasskeyChallengeRecord {
  readonly mode: PasskeyMode;
  readonly challenge: string;
}

export function serialiseChallenge(record: PasskeyChallengeRecord): string {
  return JSON.stringify(record);
}

/**
 * Parse a stored challenge, refusing anything that is not exactly the shape we
 * wrote. A malformed record means a Redis key someone else wrote, and the honest
 * answer to that is the same as to an expired challenge.
 */
export function parseChallenge(raw: string | null): PasskeyChallengeRecord {
  if (raw === null) {
    throw new ProblemException({ type: ERR.PASSKEY_CHALLENGE_INVALID });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ProblemException({ type: ERR.PASSKEY_CHALLENGE_INVALID });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProblemException({ type: ERR.PASSKEY_CHALLENGE_INVALID });
  }
  const { mode, challenge } = parsed as Record<string, unknown>;
  if ((mode !== 'register' && mode !== 'authenticate') || typeof challenge !== 'string') {
    throw new ProblemException({ type: ERR.PASSKEY_CHALLENGE_INVALID });
  }
  return { mode, challenge };
}

// ─── issuing challenges ─────────────────────────────────────────────────────

/**
 * Registration options — the attestation ceremony.
 *
 * `excludeCredentials` lists what this user already has, so the browser refuses to
 * enroll the same authenticator twice and says so in its own UI rather than letting
 * the server reject it after the fact.
 *
 * `residentKey: 'preferred'` asks for a discoverable credential where the
 * authenticator supports it, but does not demand one: requiring it excludes older
 * security keys entirely, and a non-discoverable credential is perfectly usable
 * here because `allowCredentials` always names it.
 *
 * ─── On `userVerification: 'preferred'` ────────────────────────────────────
 *
 * The same choice the admin service makes, and it sits more comfortably here. A
 * passkey is the SECOND factor — a password or an emailed code is already behind
 * it — so demanding a PIN or biometric on top adds a third prompt and hard-excludes
 * basic U2F-era keys that have no PIN.
 *
 * What it costs, stated plainly: a stolen, unlocked security key satisfies the
 * second factor. Not the first, but a touch is enough for the factor this file is
 * responsible for. The user who is worried about that has TOTP available, and a
 * platform authenticator (Touch ID, Windows Hello, an Android phone) performs user
 * verification anyway because that is how the hardware works — so in practice the
 * weak case is the bare hardware key, which is now the rare one.
 *
 * If you change this, change all four sites together: the two `userVerification`
 * values in this file and the two `requireUserVerification` values in the verify
 * functions. Demanding it at verification while merely preferring it at challenge
 * time rejects exactly the keys the preference was chosen to support.
 */
export async function buildRegistrationOptions(input: {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly existing: readonly Passkey[];
}): Promise<Record<string, unknown>> {
  const options = await generateRegistrationOptions({
    rpName: config.WEBAUTHN_RP_NAME,
    rpID: config.WEBAUTHN_RP_ID,
    userName: input.email,
    userDisplayName: input.name,
    // The user's own id, so the authenticator's stored user handle is stable across
    // re-registrations and cannot be correlated to an email address by anything
    // that reads the credential off the device.
    userID: new TextEncoder().encode(input.userId),
    timeout: policy().MFA.PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
    // 'none' — no attestation statement requested. We do not run an MDS-backed
    // allowlist of approved authenticator models, and asking for attestation we
    // will not check only collects an identifying value we have no use for.
    attestationType: 'none',
    excludeCredentials: input.existing.map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  return options as unknown as Record<string, unknown>;
}

/**
 * Authentication options — the assertion ceremony.
 *
 * `allowCredentials` is populated from the user's live passkeys rather than left
 * empty. An empty list asks the browser "which of your passkeys is for this site",
 * which is right for a passwordless FIRST factor and wrong here: the first factor
 * already told us exactly who is signing in, so naming the credentials means the
 * browser prompts for the correct authenticator instead of offering every passkey
 * the person owns.
 */
export async function buildAuthenticationOptions(
  passkeys: readonly Passkey[],
): Promise<Record<string, unknown>> {
  const options = await generateAuthenticationOptions({
    rpID: config.WEBAUTHN_RP_ID,
    timeout: policy().MFA.PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
    userVerification: 'preferred',
    allowCredentials: passkeys.map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports as AuthenticatorTransportFuture[],
    })),
  });

  return options as unknown as Record<string, unknown>;
}

/** The challenge string out of a freshly built options object, to be stored
 *  server-side. It is read back from Redis at verification and never trusted from
 *  the request. */
export function challengeOf(options: Record<string, unknown>): string {
  const challenge = options['challenge'];
  if (typeof challenge !== 'string') {
    // Unreachable unless the library changes its output shape, in which case
    // failing loudly here beats storing `undefined` and rejecting every subsequent
    // verification with a confusing error.
    throw new Error('webauthn options carried no challenge');
  }
  return challenge;
}

// ─── verifying responses ────────────────────────────────────────────────────

/** What registration verification yields, in the shape `Passkey` stores. */
export interface VerifiedRegistration {
  readonly credentialId: string;
  readonly publicKey: Uint8Array<ArrayBuffer>;
  readonly signCount: bigint;
  readonly transports: readonly string[];
  readonly aaguid: string | null;
}

export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<VerifiedRegistration> {
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.webauthnOrigin,
      expectedRPID: config.WEBAUTHN_RP_ID,
      // Presence yes, verification no — matching `userVerification: 'preferred'`
      // above. Demanding it here while merely preferring it there would reject
      // exactly the keys we deliberately chose to support.
      requireUserPresence: true,
      requireUserVerification: false,
    });
  } catch (err) {
    // The library throws for a failed signature, a wrong origin, a wrong RP ID and
    // a malformed response alike. All of them are the same answer to the caller —
    // nothing about WHY a passkey did not verify is information a client needs, and
    // some of it would help someone probing the origin check.
    logger.warn({ err }, 'passkey registration verification threw');
    throw new ProblemException({ type: ERR.PASSKEY_VERIFICATION_FAILED });
  }

  if (!result.verified || result.registrationInfo === undefined) {
    throw new ProblemException({ type: ERR.PASSKEY_VERIFICATION_FAILED });
  }

  const { credential, aaguid } = result.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: new Uint8Array(credential.publicKey),
    signCount: BigInt(credential.counter),
    transports: credential.transports ?? [],
    aaguid: aaguid === '' ? null : aaguid,
  };
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  passkey: Passkey,
): Promise<{ readonly newSignCount: bigint }> {
  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.webauthnOrigin,
      expectedRPID: config.WEBAUTHN_RP_ID,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: Number(passkey.signCount),
        transports: passkey.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: false,
    });
  } catch (err) {
    logger.warn({ err, passkeyId: passkey.id }, 'passkey authentication verification threw');
    throw new ProblemException({ type: ERR.PASSKEY_VERIFICATION_FAILED });
  }

  if (!result.verified) {
    throw new ProblemException({ type: ERR.PASSKEY_VERIFICATION_FAILED });
  }

  const newSignCount = BigInt(result.authenticationInfo.newCounter);

  /**
   * A counter that did not advance.
   *
   * The spec offers this as a clone detector: two copies of one private key would
   * each keep their own count, so a value at or below what we already stored
   * suggests the credential exists in two places.
   *
   * Logged, not refused — and that is a deliberate weakening of a defence the spec
   * offers. Most platform authenticators and every passkey synced through a
   * password manager report a permanent 0, because a credential designed to exist
   * on several devices cannot maintain a meaningful shared counter. Refusing on a
   * non-increase would therefore lock out the most common hardware in use while
   * catching almost nothing: the genuinely cloneable authenticators are the old
   * single-device security keys, which are now the rare case.
   *
   * A zero-to-zero transition is not even suspicious, so it is not logged at all —
   * otherwise the warning fires on every normal sign-in and stops being read.
   */
  if (newSignCount !== 0n && newSignCount <= passkey.signCount) {
    logger.warn(
      {
        passkeyId: passkey.id,
        userId: passkey.userId,
        storedSignCount: String(passkey.signCount),
        newSignCount: String(newSignCount),
      },
      'passkey signature counter did not advance; possible cloned authenticator',
    );
  }

  return { newSignCount };
}
