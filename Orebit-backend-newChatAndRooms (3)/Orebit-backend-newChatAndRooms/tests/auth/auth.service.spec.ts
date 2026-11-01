import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as dbOperationBarrel from '../../auth/auth.dboperation';
import * as serviceBarrel from '../../auth/auth.service';

const { AUTH_DB_OPERATIONS } = dbOperationBarrel;
const { AUTH_SERVICES } = serviceBarrel;

/**
 * The two provider lists, which are the only thing these barrels still do.
 *
 * There is no facade class to test — the controller injects services directly by
 * design — so what is actually at risk here is a *registration* gap: adding a
 * file under services/ or persistence/ and forgetting to add the class to the
 * array below. Nest would then fail at boot with an unresolved-dependency error,
 * which is a fine failure mode in development and a terrible one in a deploy.
 *
 * These read the directory rather than restating its contents, so the assertion
 * cannot drift from the tree the way a hardcoded list would.
 */

const AUTH_DIR = join(__dirname, '../../auth');

/**
 * Class names implied by the files in a directory:
 *   login.service.ts       → LoginService
 *   challenge.dboperation.ts → ChallengeDbOperation
 *
 * Note the second one is why `dboperation` needs an explicit entry rather than a
 * plain capitalise-each-segment: the file name lowercases a word boundary the
 * class name keeps. The repo has exactly two of these, so a lookup is honest and
 * a clever de-slugifier would not be.
 */
const SEGMENT_CASING: Record<string, string> = {
  service: 'Service',
  dboperation: 'DbOperation',
  // Kebab-case filenames need an entry each: the derivation below only capitalises the
  // first character, so `rate-limit-policy` would otherwise become
  // `Rate-limit-policy`. One line per multi-word file is cheaper than teaching the
  // helper a naming convention it would then own.
  'rate-limit-policy': 'RateLimitPolicy',
  'retained-email': 'RetainedEmail',
  'username-reservation': 'UsernameReservation',
};

function expectedClassNames(dir: string, suffix: string): string[] {
  return readdirSync(join(AUTH_DIR, dir))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .map((base) =>
      base
        .split('.')
        .map(
          (part) =>
            SEGMENT_CASING[part] ?? part.charAt(0).toUpperCase() + part.slice(1),
        )
        .join(''),
    )
    .filter((name) => name.endsWith(suffix))
    .sort();
}

describe('AUTH_SERVICES', () => {
  it('registers every class under auth/services/', () => {
    const registered = AUTH_SERVICES.map((s) => s.name).sort();
    expect(registered).toEqual(expectedClassNames('services', 'Service'));
  });

  it('registers each provider exactly once', () => {
    const names = AUTH_SERVICES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists CredentialService and SessionService before their consumers', () => {
    // Not a Nest requirement — the container resolves in any order. It is a
    // readability contract: the array reads as a dependency order, and someone
    // appending a service at the end should not have to wonder if it mattered.
    const names = AUTH_SERVICES.map((s) => s.name);
    expect(names.indexOf('CredentialService')).toBeLessThan(names.indexOf('LoginService'));
    expect(names.indexOf('SessionService')).toBeLessThan(names.indexOf('LoginService'));
  });
});

describe('AUTH_DB_OPERATIONS', () => {
  it('registers every class under auth/persistence/', () => {
    const registered = AUTH_DB_OPERATIONS.map((d) => d.name).sort();
    expect(registered).toEqual(expectedClassNames('persistence', 'DbOperation'));
  });

  it('registers each provider exactly once', () => {
    const names = AUTH_DB_OPERATIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers one aggregate each — registrations, sessions, devices, challenges, policies, blocked emails, retained emails, users', () => {
    expect(AUTH_DB_OPERATIONS.map((d) => d.name).sort()).toEqual([
      'BlocklistDbOperation',
      'ChallengeDbOperation',
      'DeviceDbOperation',
      'RateLimitPolicyDbOperation',
      'RegistrationDbOperation',
      // `retained_emails` is written by `src/settings/email/` and read by
      // `RegistrationService`. It lives here because a table gets one owner, and the
      // reader on the auth side cannot import from settings without a cycle — the same
      // resolution `ChallengeDbOperation` above already represents.
      'RetainedEmailDbOperation',
      'SessionDbOperation',
      'UserDbOperation',
      // `username_reservations` is written by `src/settings/username/` and read by
      // `UserDbOperation.createAccount`, which must not allocate a new account a
      // username somebody released recently. Exactly the two-sided shape above.
      'UsernameReservationDbOperation',
    ]);
  });
});

describe('the barrels re-export nothing', () => {
  it('exposes only the provider list, so there is no second name for a service', async () => {
    // The re-export blocks were removed because nothing consumed them: every
    // caller imports from services/ or persistence/ directly. If someone adds a
    // re-export back, this catches it before it becomes two import paths for one
    // class that can drift.
    expect(Object.keys(serviceBarrel)).toEqual(['AUTH_SERVICES']);
    expect(Object.keys(dbOperationBarrel)).toEqual(['AUTH_DB_OPERATIONS']);
  });
});
