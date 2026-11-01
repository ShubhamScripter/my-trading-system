import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The chat models in db/schema.prisma must match what the chat migrations build. Runs
 * `prisma migrate diff` from the migrations to the schema and fails on any difference in the chat schema — except
 * the objects Prisma cannot express, each listed here by name (see the note at the top of the chat section of
 * db/schema.prisma).
 *
 * Needs a scratch database for Prisma's shadow copy; skipped unless both are set:
 *   CHAT_TEST_DATABASE_URL=…/orebit_chat_verify CHAT_TEST_SHADOW_DATABASE_URL=…/orebit_chat_shadow
 * Running it in CI is the .github owner's decision.
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const shadow = process.env.CHAT_TEST_SHADOW_DATABASE_URL;

/** Links from chat columns to identity.users: kept out of the User model, which is not chat's. */
const USER_LINKS = new Set([
  'chat_message_reports_reported_user_id_fkey',
  'chat_message_reports_reporter_id_fkey',
  'chat_warnings_issued_by_fkey',
  'chat_warnings_user_id_fkey',
  'message_mentions_mentioned_user_id_fkey',
  'room_excluded_users_user_id_fkey',
  'room_messages_pinned_by_fkey',
  'room_messages_retracted_by_fkey',
  'staff_roles_user_id_fkey',
  'test_entitlements_user_id_fkey',
  'user_bans_moderator_id_fkey',
  'user_bans_user_id_fkey',
  'user_chat_preferences_user_id_fkey',
  // Modules 4–9.
  'user_restrictions_created_by_fkey',
  'staff_requests_requester_id_fkey',
  'user_mutes_user_id_fkey',
  'user_mutes_target_id_fkey',
  'user_blocks_user_id_fkey',
  'user_blocks_target_id_fkey',
  'chat_ads_creator_id_fkey',
  'gift_transfers_sender_id_fkey',
  'gift_transfers_recipient_id_fkey',
  'dm_conversations_created_by_fkey',
  'dm_members_user_id_fkey',
  'dm_groups_owner_id_fkey',
  'dm_group_invites_invitee_id_fkey',
  'room_included_users_user_id_fkey',
  // Module 10.
  'support_tickets_user_id_fkey',
  'support_messages_sender_user_id_fkey',
]);

/** Indexes the migrations build that Prisma has no syntax for (a trigram index needs the pg_trgm extension). */
const NOT_IN_PRISMA = new Set([
  'dm_groups_name_trgm_idx',
  // Partial unique indexes (one key per advertiser, one reference, one ACTIVE slot per room) and a partial index.
  'chat_ads_creator_key_key',
  'chat_ads_charge_reference_key',
  'chat_ads_pending_payment_idx',
  'gift_transfers_transfer_reference_key',
  'chat_ad_placements_room_active_key',
  // Live-key unique indexes: the old key now holds only for rows not removed (FR-237).
  'user_mutes_live_key',
  'user_blocks_live_key',
  'room_excluded_users_live_key',
  'room_included_users_live_key',
  'dm_group_bans_live_key',
  'staff_roles_live_key',
]);

/** A statement that only reflects what Prisma cannot express. */
function expected(statement: string): boolean {
  const fk = /DROP CONSTRAINT "([^"]+)"/.exec(statement);
  if (fk && USER_LINKS.has(fk[1]!)) return true;
  const index = /^DROP INDEX "chat"."([^"]+)";$/.exec(statement.trim());
  if (index && NOT_IN_PRISMA.has(index[1]!)) return true;
  // `@default(dbgenerated("now()"))` (so Prisma never sends the app clock) always reads as a change.
  return /^ALTER TABLE "chat"\."\w+" ALTER COLUMN "\w+" SET DEFAULT now\(\)(,\s*ALTER COLUMN "\w+" SET DEFAULT now\(\))*;$/.test(
    statement
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/, ALTER/g, ',ALTER')
      .replace(/,ALTER/g, ', ALTER'),
  );
}

describe.skipIf(!url || !shadow)('chat schema drift', () => {
  it('the chat models match the chat migrations', () => {
    const root = join(__dirname, '..', '..');
    const prismaCli = require.resolve('prisma/build/index.js');
    const script = execFileSync(
      process.execPath,
      [
        prismaCli,
        'migrate',
        'diff',
        '--from-migrations',
        join(root, 'db', 'migrations'),
        '--to-schema-datamodel',
        join(root, 'db', 'schema.prisma'),
        '--shadow-database-url',
        shadow!,
        '--script',
      ],
      { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } },
    );

    const statements = script
      .split(/;\s*\n/)
      .map((s) => s.replace(/^--.*$/gm, '').trim())
      .filter((s) => s.length > 0 && s.includes('"chat"'))
      .map((s) => `${s};`);

    expect(statements.filter((s) => !expected(s))).toEqual([]);
  }, 120_000);
});
