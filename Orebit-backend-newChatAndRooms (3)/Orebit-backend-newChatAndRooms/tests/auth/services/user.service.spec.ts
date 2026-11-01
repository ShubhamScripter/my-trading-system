import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import type { MailService } from '../../../src/mail/mail.service';
import { USERNAME } from '../../../auth/auth.constants';
import type { CreateAccountInput, UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { UsernameTakenError } from '../../../auth/persistence/username-reservation.dboperation';
import { UserService } from '../../../auth/services/user.service';
import {
  makeCredential,
  makeRegistration,
  makeUser,
  rawUniqueViolation,
  uniqueViolation,
} from '../../harness';

/**
 * UserService against a hand-written double of its dboperation.
 *
 * No database, and no Prisma beyond the error classes — which is the property
 * the dboperation split exists to buy (README, "Module convention"). Everything
 * asserted here is policy: which identifier is derived from what, when a retry
 * happens, and which failure is an expected outcome versus a bug.
 */

function createUsers() {
  return {
    createAccount: vi.fn(),
    emailExists: vi.fn().mockResolvedValue(false),
    findByReferralCode: vi.fn().mockResolvedValue(null),
    findOauthLink: vi.fn().mockResolvedValue(null),
    findWithCredential: vi.fn().mockResolvedValue(null),
    setCountry: vi.fn(),
  };
}

function createMail() {
  return { sendWelcome: vi.fn().mockResolvedValue(undefined) };
}

let users: ReturnType<typeof createUsers>;
let mail: ReturnType<typeof createMail>;
let service: UserService;

beforeEach(() => {
  users = createUsers();
  mail = createMail();
  service = new UserService(
    users as unknown as UserDbOperation,
    mail as unknown as MailService,
  );
});

/** The input the service handed to `createAccount` on its nth attempt. */
function attempt(n: number): CreateAccountInput {
  return users.createAccount.mock.calls[n]?.[0] as CreateAccountInput;
}

describe('UserService.createFromRegistration', () => {
  it('creates the account from the registration, seeding the username from the email', async () => {
    const registration = makeRegistration();
    const created = { user: makeUser(), credential: makeCredential() };
    users.createAccount.mockResolvedValue(created);

    await expect(
      service.createFromRegistration({
        registration,
        passwordHash: 'argon2-hash',
        country: 'GB',
        countryIp: '203.0.113.7',
        oauthName: null,
      }),
    ).resolves.toBe(created);

    expect(users.createAccount).toHaveBeenCalledOnce();
    expect(attempt(0)).toMatchObject({
      email: registration.email,
      emailLower: registration.emailLower,
      emailVerified: true,
      username: 'ada_lovelace',
      country: 'GB',
      countryIp: '203.0.113.7',
      passwordHash: 'argon2-hash',
      oauth: null,
      registrationId: registration.id,
    });
    expect(attempt(0).publicCode).toMatch(/^OREBiT[0-9A-HJKMNP-TV-Z]{8}$/);
    // The lookup key is the uppercased code — the column the partial unique
    // index is on, and what a user's typed code is matched against.
    expect(attempt(0).publicCodeKey).toBe(attempt(0).publicCode.toUpperCase());
  });

  it('records the address as unverified when the registration never proved it', async () => {
    users.createAccount.mockResolvedValue({ user: makeUser(), credential: null });

    await service.createFromRegistration({
      registration: makeRegistration({ emailVerifiedAt: null }),
      passwordHash: null,
      country: 'GB',
      countryIp: null,
      oauthName: null,
    });

    expect(attempt(0).emailVerified).toBe(false);
    expect(attempt(0).passwordHash).toBeNull();
  });

  it('prefers the provider display name over the email local part as the seed', async () => {
    // The name the user recognises as their own: `grace_hopper` reads better
    // than whatever their address happens to be.
    const registration = makeRegistration({
      email: 'ghopper@example.test',
      emailLower: 'ghopper@example.test',
      oauthProvider: 'GOOGLE',
      oauthSubject: 'google-subject-1',
      oauthEmailVerified: true,
    });
    users.createAccount.mockResolvedValue({ user: makeUser(), credential: null });

    await service.createFromRegistration({
      registration,
      passwordHash: null,
      country: 'US',
      countryIp: null,
      oauthName: 'Grace Hopper',
    });

    expect(attempt(0).username).toBe('grace_hopper');
    expect(attempt(0).oauth).toEqual({
      provider: 'GOOGLE',
      subject: 'google-subject-1',
      emailAtLink: registration.email,
      emailVerifiedByProvider: true,
      avatarUrl: null,
    });
  });

  it('links the referrer when the entered code resolves, matching case-insensitively', async () => {
    const referrer = makeUser({ id: 'referrer-id' });
    users.findByReferralCode.mockResolvedValue(referrer);
    users.createAccount.mockResolvedValue({ user: makeUser(), credential: null });

    await service.createFromRegistration({
      registration: makeRegistration({ referralCodeEntered: ' k7m2p9qr ' }),
      passwordHash: 'argon2-hash',
      country: 'GB',
      countryIp: null,
      oauthName: null,
    });

    expect(users.findByReferralCode).toHaveBeenCalledWith('K7M2P9QR');
    expect(attempt(0).referredByUserId).toBe('referrer-id');
    // The raw string is kept as entered, so attribution survives the referrer
    // being deleted later.
    expect(attempt(0).referredByCode).toBe(' k7m2p9qr ');
  });

  it('accepts and ignores a referral code that matches nothing', async () => {
    // Product rule: a mistyped code must not cost someone their signup.
    users.findByReferralCode.mockResolvedValue(null);
    users.createAccount.mockResolvedValue({ user: makeUser(), credential: null });

    await service.createFromRegistration({
      registration: makeRegistration({ referralCodeEntered: 'NOSUCHCD' }),
      passwordHash: 'argon2-hash',
      country: 'GB',
      countryIp: null,
      oauthName: null,
    });

    expect(attempt(0).referredByUserId).toBeNull();
    expect(attempt(0).referredByCode).toBe('NOSUCHCD');
  });

  it('does not look up a referrer when no code was entered', async () => {
    users.createAccount.mockResolvedValue({ user: makeUser(), credential: null });

    await service.createFromRegistration({
      registration: makeRegistration({ referralCodeEntered: null }),
      passwordHash: null,
      country: 'GB',
      countryIp: null,
      oauthName: null,
    });

    expect(users.findByReferralCode).not.toHaveBeenCalled();
  });

  it('sends the welcome mail with the created account details', async () => {
    const user = makeUser({ email: 'ada@example.test', username: 'ada', publicCode: 'OREBiTAAAA1111' });
    users.createAccount.mockResolvedValue({ user, credential: makeCredential() });

    await service.createFromRegistration({
      registration: makeRegistration(),
      passwordHash: 'argon2-hash',
      country: 'GB',
      countryIp: null,
      oauthName: null,
    });

    expect(mail.sendWelcome).toHaveBeenCalledWith('ada@example.test', 'ada', 'OREBiTAAAA1111');
  });

  it('retries with fresh identifiers when the insert hits a unique violation', async () => {
    const created = { user: makeUser(), credential: null };
    users.createAccount.mockRejectedValueOnce(uniqueViolation()).mockResolvedValue(created);

    await expect(
      service.createFromRegistration({
        registration: makeRegistration(),
        passwordHash: 'argon2-hash',
        country: 'GB',
        countryIp: null,
        oauthName: null,
      }),
    ).resolves.toBe(created);

    expect(users.createAccount).toHaveBeenCalledTimes(2);
    // Insert-and-catch, not check-then-insert: the index is the authority, and
    // the second attempt must differ or the retry is pointless.
    expect(attempt(1).username).not.toBe(attempt(0).username);
    expect(attempt(1).publicCode).not.toBe(attempt(0).publicCode);
    expect(attempt(1).referralCode).not.toBe(attempt(0).referralCode);
  });

  it('treats a raw-SQL partial-index violation as a retryable collision too', async () => {
    // `ix_users_username_active` is created outside Prisma, so it surfaces as
    // SQLSTATE 23505 on the unknown-error class rather than as P2002.
    const created = { user: makeUser(), credential: null };
    users.createAccount.mockRejectedValueOnce(rawUniqueViolation()).mockResolvedValue(created);

    await expect(
      service.createFromRegistration({
        registration: makeRegistration(),
        passwordHash: 'argon2-hash',
        country: 'GB',
        countryIp: null,
        oauthName: null,
      }),
    ).resolves.toBe(created);

    expect(users.createAccount).toHaveBeenCalledTimes(2);
  });

  it('resolves the referrer once, not per retry', async () => {
    users.findByReferralCode.mockResolvedValue(makeUser({ id: 'referrer-id' }));
    users.createAccount
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValue({ user: makeUser(), credential: null });

    await service.createFromRegistration({
      registration: makeRegistration({ referralCodeEntered: 'K7M2P9QR' }),
      passwordHash: 'argon2-hash',
      country: 'GB',
      countryIp: null,
      oauthName: null,
    });

    expect(users.findByReferralCode).toHaveBeenCalledOnce();
  });

  it('reports email_already_registered when the collision was on the address', async () => {
    // A different username cannot make the address free, so this one is not
    // retryable — someone registered it while this attempt was in flight.
    users.createAccount.mockRejectedValue(uniqueViolation('users_email_lower_key'));
    users.emailExists.mockResolvedValue(true);

    await expect(
      service.createFromRegistration({
        registration: makeRegistration(),
        passwordHash: 'argon2-hash',
        country: 'GB',
        countryIp: null,
        oauthName: null,
      }),
    ).rejects.toMatchObject({ type: ERR.EMAIL_ALREADY_REGISTERED, status: 409 });

    expect(users.createAccount).toHaveBeenCalledOnce();
    expect(mail.sendWelcome).not.toHaveBeenCalled();
  });

  it('gives up loudly once every candidate has collided', async () => {
    users.createAccount.mockRejectedValue(uniqueViolation());

    await expect(
      service.createFromRegistration({
        registration: makeRegistration(),
        passwordHash: 'argon2-hash',
        country: 'GB',
        countryIp: null,
        oauthName: null,
      }),
    ).rejects.toMatchObject({ type: ERR.USERNAME_GENERATION_FAILED, status: 500 });

    expect(users.createAccount).toHaveBeenCalledTimes(USERNAME.MAX_ALLOCATION_ATTEMPTS);
  });

  it('moves to the next candidate when one is RESERVED rather than taken', async () => {
    // Not a constraint violation: no live account holds the name, so the unique index
    // is satisfied and only `username_reservations` knows it is spoken for. Without
    // this branch a signup would be handed a username somebody released an hour ago.
    users.createAccount
      .mockRejectedValueOnce(new UsernameTakenError())
      .mockImplementationOnce(async (input: CreateAccountInput) => ({
        user: makeUser({ username: input.username }),
        credential: null,
      }));

    await service.createFromRegistration({
      registration: makeRegistration(),
      passwordHash: 'argon2-hash',
      country: 'GB',
      countryIp: null,
      oauthName: null,
    });

    expect(users.createAccount).toHaveBeenCalledTimes(2);
    expect(attempt(1).username).not.toBe(attempt(0).username);
  });

  it('still gives up loudly when every candidate is reserved', async () => {
    users.createAccount.mockRejectedValue(new UsernameTakenError());

    await expect(
      service.createFromRegistration({
        registration: makeRegistration(),
        passwordHash: 'argon2-hash',
        country: 'GB',
        countryIp: null,
        oauthName: null,
      }),
    ).rejects.toMatchObject({ type: ERR.USERNAME_GENERATION_FAILED, status: 500 });

    expect(users.createAccount).toHaveBeenCalledTimes(USERNAME.MAX_ALLOCATION_ATTEMPTS);
  });

  it('never asks whether the email exists for a reserved username', async () => {
    // A reservation says nothing about the address, and treating it as an email
    // collision would report `email_already_registered` for a name clash.
    users.createAccount.mockRejectedValue(new UsernameTakenError());

    await expect(
      service.createFromRegistration({
        registration: makeRegistration(),
        passwordHash: 'argon2-hash',
        country: 'GB',
        countryIp: null,
        oauthName: null,
      }),
    ).rejects.toMatchObject({ type: ERR.USERNAME_GENERATION_FAILED });

    expect(users.emailExists).not.toHaveBeenCalled();
  });

  it('generates only candidates a free account is allowed to keep', async () => {
    // The floor moved from three to seven when usernames became changeable, and a
    // generated name the owner could not legally re-choose would be an odd default.
    users.createAccount.mockRejectedValue(uniqueViolation());

    await expect(
      service.createFromRegistration({
        registration: makeRegistration(),
        passwordHash: 'argon2-hash',
        country: 'GB',
        countryIp: null,
        oauthName: null,
      }),
    ).rejects.toMatchObject({ type: ERR.USERNAME_GENERATION_FAILED });

    for (let i = 0; i < USERNAME.MAX_ALLOCATION_ATTEMPTS; i += 1) {
      expect(attempt(i).username.length).toBeGreaterThanOrEqual(USERNAME.DEFAULT_MIN_LENGTH);
      expect(attempt(i).username.length).toBeLessThanOrEqual(USERNAME.MAX_LENGTH);
    }
  });

  it('rethrows anything that is not a unique violation, untouched', async () => {
    // A connection failure is a bug or an outage, not a name collision —
    // swallowing it into the retry loop would turn it into six of them.
    const failure = new Error('connection terminated unexpectedly');
    users.createAccount.mockRejectedValue(failure);

    await expect(
      service.createFromRegistration({
        registration: makeRegistration(),
        passwordHash: 'argon2-hash',
        country: 'GB',
        countryIp: null,
        oauthName: null,
      }),
    ).rejects.toBe(failure);

    expect(users.createAccount).toHaveBeenCalledOnce();
    expect(users.emailExists).not.toHaveBeenCalled();
  });
});

describe('UserService.lookupReferrer', () => {
  it('normalises the code before looking it up', async () => {
    users.findByReferralCode.mockResolvedValue(makeUser({ username: 'ada_lovelace' }));

    await expect(service.lookupReferrer(' k7m2p9qr ')).resolves.toEqual({
      username: 'ada_lovelace',
    });
    expect(users.findByReferralCode).toHaveBeenCalledWith('K7M2P9QR');
  });

  it('returns null for a code that matches no live account', async () => {
    users.findByReferralCode.mockResolvedValue(null);
    await expect(service.lookupReferrer('NOSUCHCD')).resolves.toBeNull();
  });
});

describe('UserService.findLinkedAccount', () => {
  it('delegates the provider identity lookup', async () => {
    const link = { id: 'link-id', user: makeUser() };
    users.findOauthLink.mockResolvedValue(link);

    await expect(service.findLinkedAccount('GOOGLE', 'google-subject-1')).resolves.toBe(link);
    expect(users.findOauthLink).toHaveBeenCalledWith('GOOGLE', 'google-subject-1');
  });
});

describe('UserService.getCurrentUser', () => {
  it('projects the account, reporting whether it has a password', async () => {
    users.findWithCredential.mockResolvedValue({
      user: makeUser(),
      credential: makeCredential(),
    });

    await expect(service.getCurrentUser('user-id')).resolves.toMatchObject({
      publicCode: 'OREBiT7Q9K2M4X',
      username: 'ada_lovelace',
      emailVerified: true,
      hasPassword: true,
    });
  });

  it('reports hasPassword false for an account created through a provider', async () => {
    users.findWithCredential.mockResolvedValue({ user: makeUser(), credential: null });

    await expect(service.getCurrentUser('user-id')).resolves.toMatchObject({
      hasPassword: false,
    });
  });

  it('rejects a token whose account no longer exists as unauthenticated', async () => {
    // A soft-deleted account outlived by a valid token. Neither a 500 nor a 404
    // — the second would disclose that the account was once real.
    users.findWithCredential.mockResolvedValue(null);

    await expect(service.getCurrentUser('user-id')).rejects.toMatchObject({
      type: ERR.UNAUTHENTICATED,
      status: 401,
    });
    await expect(service.getCurrentUser('user-id')).rejects.toBeInstanceOf(ProblemException);
  });
});

describe('UserService.updateMyProfile', () => {
  it('writes the country and returns the updated projection', async () => {
    users.findWithCredential.mockResolvedValue({
      user: makeUser({ countryDeclared: 'GB' }),
      credential: makeCredential(),
    });
    users.setCountry.mockResolvedValue(makeUser({ countryDeclared: 'FR' }));

    await expect(service.updateMyProfile('user-id', { country: 'FR' })).resolves.toMatchObject({
      country: 'FR',
      hasPassword: true,
    });
    expect(users.setCountry).toHaveBeenCalledWith('user-id', 'FR');
  });

  it('does not write anything for an account that no longer exists', async () => {
    users.findWithCredential.mockResolvedValue(null);

    await expect(
      service.updateMyProfile('user-id', { country: 'FR' }),
    ).rejects.toMatchObject({ type: ERR.UNAUTHENTICATED });
    expect(users.setCountry).not.toHaveBeenCalled();
  });
});
