/**
 * Seed data.
 *
 *   npm run db:seed
 *
 * Idempotent, and has to be: it runs against environments that already have data,
 * so every insert here either creates a row or leaves the existing one exactly as
 * it was. Never an upsert that overwrites — an operator's hand-edited row is the
 * more authoritative of the two, and a seed that clobbered it would silently undo
 * a deliberate decision.
 */

import { PrismaClient } from '@prisma/client';
import { classifyBlocklistValue } from '../auth/security/blocklist';
import { DISPOSABLE_EMAIL_DOMAINS } from '../src/utils/disposable-email';
import { uuidv7 } from '../src/utils/public.utils';

const prisma = new PrismaClient();

/**
 * Give `identity.blocked_emails` its starting contents.
 *
 * The alternative — ship with an empty table and let an operator fill it — sounds
 * cleaner and is worse in exactly one way that matters: until somebody notices,
 * every throwaway address on the internet can sign up. A stale default beats no
 * default.
 *
 * Existing rows are left alone, so re-running after refreshing the list adds the
 * new domains and preserves both the seeded rows and anything blocked by hand.
 */
async function seedBlockedEmails(): Promise<void> {
  const rows = DISPOSABLE_EMAIL_DOMAINS.flatMap((domain) => {
    // Classified rather than trusted, so a malformed entry in the list becomes a
    // skipped row instead of one that sits in the table matching nothing.
    const classified = classifyBlocklistValue(domain);
    if (classified === null) {
      console.warn(`blocked_emails: skipping unusable entry ${JSON.stringify(domain)}`);
      return [];
    }
    return [
      {
        id: uuidv7(),
        kind: classified.kind,
        value: classified.value,
        reason: 'Known disposable email provider (seeded)',
        // Null: nobody approved this individually, and recording a fake admin
        // would make the audit trail lie.
        createdBy: null,
      },
    ];
  });

  // Chunked because a single 8,000-row INSERT is one very large statement and one
  // very long-held lock, for no gain.
  const CHUNK = 1_000;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { count } = await prisma.blockedEmail.createMany({
      data: rows.slice(i, i + CHUNK),
      skipDuplicates: true,
    });
    inserted += count;
  }

  const total = await prisma.blockedEmail.count();
  console.log(
    `blocked_emails: ${inserted} inserted, ${rows.length - inserted} already present, ${total} total`,
  );
}

async function main(): Promise<void> {
  await seedBlockedEmails();
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
