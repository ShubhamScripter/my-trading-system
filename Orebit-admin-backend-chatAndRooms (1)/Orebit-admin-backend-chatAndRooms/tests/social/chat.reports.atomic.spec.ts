import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ChatModerationDbOperation } from '../../src/social/chat/chat-moderation.dboperation';
import { ChatModerationService } from '../../src/social/chat/services/chat-moderation.service';
import { ChatStaffDbOperation } from '../../src/social/chat/persistence/chat-staff.dboperation';
import { ChatUtility } from '../../src/social/chat/chat.utility';

/**
 * FR-094 and FR-097 on a real database: two admins acting on one report at the same moment make ONE ban (or ONE warning),
 * the loser gets 409, and a WARN is a real warning row that the user's warnings and the staff count can see.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run tests/social/chat.reports.atomic.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;

describe.skipIf(!url)('acting on a report is atomic (scratch database)', () => {
  let prisma: PrismaClient;
  let service: ChatModerationService;
  const tag = ChatUtility.generateUuid().slice(-6);
  const reported = ChatUtility.generateUuid();
  const reporter = ChatUtility.generateUuid();
  const [adminA, adminB] = [ChatUtility.generateUuid(), ChatUtility.generateUuid()];

  const user = async (id: string, name: string) =>
    prisma.$executeRaw`
      INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
      VALUES (${id}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
    `;
  const report = async () => {
    const id = ChatUtility.generateUuid();
    await prisma.$executeRaw`
      INSERT INTO chat.chat_message_reports (id, reporter_id, reported_user_id, reason, status)
      VALUES (${id}::uuid, ${reporter}::uuid, ${reported}::uuid, 'atomic_test', 'PENDING'::chat."ReportStatus")
    `;
    return id;
  };
  const outcome = (run: () => Promise<unknown>) =>
    run().then(
      () => 'ok',
      (e: { type?: string }) => e.type ?? 'error',
    );

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$executeRaw`INSERT INTO chat.report_reasons (code, label, report_type, is_active, sort_order)
      VALUES ('atomic_test', 'Atomic test', 'MESSAGE', true, 999)
      ON CONFLICT (code, report_type) DO NOTHING`;
    await user(reported, `rep${tag}`);
    await user(reporter, `rpr${tag}`);
    const db = new ChatModerationDbOperation(prisma as never);
    service = new ChatModerationService(db, new ChatStaffDbOperation(prisma as never));
  });

  afterAll(async () => prisma?.$disconnect());

  it('two admins banning from one report make one ban; the loser is told it is resolved', async () => {
    const id = await report();
    const results = await Promise.all(
      [adminA, adminB].map((admin) => outcome(() => service.actionReport({ reportId: id, action: 'BAN', note: 'Harassment', banPermanent: true } as never, admin))),
    );
    expect(results.sort()).toEqual([ERR.CHAT_REPORT_ALREADY_RESOLVED, 'ok'].sort());
    const [bans] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM chat.user_bans WHERE user_id = ${reported}::uuid`;
    expect(bans!.n).toBe(1);
    // One audit row for the winner, none for the loser.
    const [audit] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.moderation_actions WHERE target_user_id = ${reported}::uuid AND action = 'REPORT_BAN'
    `;
    expect(audit!.n).toBe(1);
  });

  it('a WARN on a report is a warning row, once, with one audit row', async () => {
    const id = await report();
    const results = await Promise.all(
      [adminA, adminB].map((admin) => outcome(() => service.actionReport({ reportId: id, action: 'WARN', note: 'Be kind' } as never, admin))),
    );
    expect(results.sort()).toEqual([ERR.CHAT_REPORT_ALREADY_RESOLVED, 'ok'].sort());
    const [warnings] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.chat_warnings WHERE user_id = ${reported}::uuid AND internal_reason = 'Be kind'
    `;
    expect(warnings!.n).toBe(1);
    const [audit] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.moderation_actions WHERE target_user_id = ${reported}::uuid AND action IN ('WARN', 'REPORT_WARN')
    `;
    expect(audit!.n).toBe(1);
  });

  it('when the action fails the claim is undone with it: the report stays PENDING', async () => {
    const id = await report();
    // A ban for a user that no longer exists breaks the foreign key inside the transaction.
    await prisma.$executeRaw`UPDATE chat.chat_message_reports SET reported_user_id = ${reported}::uuid WHERE id = ${id}::uuid`;
    const db = new ChatModerationDbOperation(prisma as never);
    const failed = await db
      .actOnReport(id, 'BAN', adminA, async () => {
        throw new Error('the action failed');
      })
      .then(
        () => 'ok',
        () => 'failed',
      );
    expect(failed).toBe('failed');
    const [row] = await prisma.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM chat.chat_message_reports WHERE id = ${id}::uuid`;
    expect(row!.status).toBe('PENDING');
  });
});
