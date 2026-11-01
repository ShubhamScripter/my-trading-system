/**
 * Admin provisioning.
 *
 *   npm run db:seed                    create the first SUPER_ADMIN from env
 *   npm run db:seed -- --force         allow it in production
 *
 * ─── Why this is the whole provisioning story ───────────────────────────────
 *
 * There is no signup route, no invite flow, and no "create admin" endpoint. An
 * admin account comes into existence by someone with database credentials running
 * this script, which means the set of people who can mint platform administrators
 * is exactly the set of people who already hold the database.
 *
 * That is a deliberate floor rather than a missing feature. An invite flow is the
 * obvious next step and it is a real one — it needs its own token lifetime, its own
 * rate limits, and a decision about who may invite whom — so until that is designed
 * properly, no route can create an admin.
 *
 * ─── The seeded account has NO second factor ────────────────────────────────
 *
 * Deliberately. `mfaEnrolledAt` stays null, so the first sign-in goes through the
 * forced-enrollment branch: password → email code → enroll TOTP or a passkey →
 * session. Pre-provisioning a factor here would mean the secret existed in a shell
 * history and a script's output before the admin ever touched it.
 */

import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

/** Mirrors auth/auth.constants.ts. Duplicated rather than imported because this
 *  script runs under tsx without the Nest module graph, and importing the
 *  constants would pull in src/config.ts's import-time env parsing. */
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 20;
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** UUIDv7, matching src/utils/public.utils.ts. Same reason for the copy. */
function uuidv7(): string {
  const bytes = randomBytes(16);
  const millis = Date.now();
  bytes[0] = (millis / 2 ** 40) & 0xff;
  bytes[1] = (millis / 2 ** 32) & 0xff;
  bytes[2] = (millis / 2 ** 24) & 0xff;
  bytes[3] = (millis / 2 ** 16) & 0xff;
  bytes[4] = (millis / 2 ** 8) & 0xff;
  bytes[5] = millis & 0xff;
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

/**
 * The same four character classes `passwordSchema` demands, checked here because
 * this path never goes through a DTO.
 *
 * A seed script that quietly accepted `admin` as a password would be the single
 * worst hole in this service — it creates a SUPER_ADMIN, and it is the one code
 * path where nobody is watching the response.
 */
function assertPasswordAcceptable(password: string, email: string): void {
  const problems: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password)) problems.push('must contain a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('must contain an uppercase letter');
  if (!/\d/.test(password)) problems.push('must contain a digit');
  if (!/[^a-zA-Z0-9\s]/.test(password)) problems.push('must contain a special character');

  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local)) {
    problems.push('must not contain the email address');
  }

  if (problems.length > 0) {
    throw new Error(`SEED_ADMIN_PASSWORD is not acceptable:\n  ${problems.join('\n  ')}`);
  }
}

/**
 * Refuse to run against production without an explicit flag.
 *
 * The failure this prevents is mundane and expensive: a `.env` still pointed at
 * production, a habitual `npm run db:seed`, and a new SUPER_ADMIN whose password
 * is in a developer's shell history.
 */
function assertEnvironmentAllows(): void {
  const forced = process.argv.includes('--force');
  if (process.env['NODE_ENV'] === 'production' && !forced) {
    throw new Error(
      'refusing to seed with NODE_ENV=production.\n' +
        '  Pass --force if you genuinely mean to create a production administrator.',
    );
  }
}

/**
 * ═══ THE LAST MOMENT THE PEPPER CAN STILL BE CHANGED ═══════════════════════
 *
 * `src/config.ts` refuses the placeholder at boot in production, and this repeats
 * the check for two reasons.
 *
 * The first is mechanical: this script runs under `tsx` and never imports
 * `src/config.ts`, so that check does not protect it — the same reason
 * `assertSchemaScoped` is duplicated in `db/migrate.ts`.
 *
 * The second is that THIS is the point of no return. The pepper is argon2's
 * `secret`, so the moment this script writes a password hash the value is frozen:
 * changing it afterwards makes every stored hash unverifiable and locks out every
 * admin at once. Refusing here is refusing while it is still free to fix; refusing
 * one command later is a database to clean up.
 *
 * Checked regardless of NODE_ENV, unlike config.ts's production-only rule. A
 * developer seeding a shared staging database with the public pepper is the case
 * that check cannot see, and the fix is equally cheap.
 */
function assertPepperIsNotAPlaceholder(): void {
  const KNOWN_PLACEHOLDERS = [
    'change-me-to-a-random-32-plus-character-secret',
    'change-me-to-a-random-32-plus-character-secret!',
    'test-pepper-that-is-long-enough-to-pass-validation',
  ];

  if (!KNOWN_PLACEHOLDERS.includes(required('PASSWORD_PEPPER'))) return;

  throw new Error(
    'refusing to seed with the .env.example PASSWORD_PEPPER.\n' +
      '  That value is published in this repository, and it is argon2id\'s `secret`\n' +
      '  parameter — so it is what stands between a stolen credential table and an\n' +
      '  offline attack on it.\n' +
      '\n' +
      '  Generate one:  openssl rand -base64 36\n' +
      '\n' +
      '  Do it NOW rather than after seeding. Once this script writes a password\n' +
      '  hash the pepper is frozen: every stored hash is only verifiable with the\n' +
      '  exact value used to create it, so changing it later locks out every admin\n' +
      '  and the only remedy is re-seeding.',
  );
}

async function main(): Promise<void> {
  assertEnvironmentAllows();
  assertPepperIsNotAPlaceholder();

  const email = required('SEED_ADMIN_EMAIL').trim();
  const password = required('SEED_ADMIN_PASSWORD');
  const name = (process.env['SEED_ADMIN_NAME'] ?? email.split('@')[0] ?? 'Administrator').trim();
  const emailLower = email.toLowerCase();

  assertPasswordAcceptable(password, email);

  // Idempotent. Re-running must not reset an existing admin's password — that
  // would turn this script into an unauthenticated password-reset tool for anyone
  // who reaches the shell.
  const existing = await prisma.admin.findFirst({ where: { emailLower, deletedAt: null } });
  if (existing !== null) {
    console.log(`admin already exists: ${existing.email} (${existing.role})`);
    console.log(
      'nothing to do — this script never resets an existing password, by design.\n' +
        '\n' +
        '  There is no password-reset flow either. It was removed because email is\n' +
        '  already the second factor here, so emailed recovery would collapse the\n' +
        '  three-factor ceremony down to control of one mailbox.\n' +
        '\n' +
        '  What a super admin CAN do, at POST /admins:\n' +
        '    reset-factors          an admin who lost their authenticator\n' +
        '    disable / enable       take an account out of service, or restore it\n' +
        '    resolve-login-review   decide a suspension from repeated lockouts\n' +
        '\n' +
        '  None of those changes a password. Changing one has no supported path\n' +
        '  today and needs a deliberate database write.',
    );
    return;
  }

  const passwordHash = await argon2.hash(password, {
    ...ARGON2_OPTIONS,
    secret: Buffer.from(required('PASSWORD_PEPPER'), 'utf8'),
  });

  const adminId = uuidv7();
  await prisma.$transaction(async (tx) => {
    await tx.admin.create({
      data: {
        id: adminId,
        email,
        emailLower,
        name,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        // Both null on purpose. The address has never been proven, and there is no
        // second factor — the first sign-in proves the one and enrolls the other.
        emailVerifiedAt: null,
        mfaEnrolledAt: null,
      },
    });
    await tx.adminCredential.create({
      data: { id: uuidv7(), adminId, kind: 'PASSWORD', passwordHash },
    });
  });

  console.log(`created SUPER_ADMIN ${email}`);
  console.log('');
  console.log('This account has NO second factor. Its first sign-in will require:');
  console.log('  1. password + captcha');
  console.log('  2. the emailed verification code');
  console.log('  3. enrolling an authenticator app or a passkey');
  console.log('');
  console.log('With MAIL_TRANSPORT=console the code is printed to the server log.');
  console.log('');
  console.log('KEEP THE PASSWORD ABOVE UNTIL STEP 3 IS DONE.');
}

/**
 * A fingerprint of the password, so a later "which password did we seed" question
 * is answerable without the password itself being recoverable. Eight hex
 * characters is enough to compare two candidates and far too short to attack.
 */
function passwordTag(password: string): string {
  return createHash('sha256').update(password).digest('hex').slice(0, 8);
}

void main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err: unknown) => {
    console.error((err as Error).message);
    // Logged only on failure, and only as a tag: if the script refuses a password
    // the operator needs to know WHICH value was refused when several are in play.
    const password = process.env['SEED_ADMIN_PASSWORD'];
    if (password !== undefined && password !== '') {
      console.error(`  (SEED_ADMIN_PASSWORD fingerprint: ${passwordTag(password)})`);
    }
    await prisma.$disconnect();
    process.exit(1);
  });
