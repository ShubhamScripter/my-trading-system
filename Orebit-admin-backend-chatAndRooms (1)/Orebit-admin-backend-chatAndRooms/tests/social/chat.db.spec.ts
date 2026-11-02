import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ChatModerationDbOperation } from '../../src/social/chat/chat-moderation.dboperation';
import { ChatModulesDbOperation } from '../../src/social/chat/persistence/chat-modules.dboperation';
import { ChatMoneyDbOperation } from '../../src/social/chat/persistence/chat-money.dboperation';
import type { PrismaService } from '../../db/client';

/**
 * Database-backed checks on the admin's chat queries: the ban ends on the database clock, a retract is
 * atomic, and dismissing a report records DISMISSED. Runs against a MIGRATED database named by
 * CHAT_TEST_DATABASE_URL (never the development database); skipped when it is not set:
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run tests/social/chat.db.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;

describe.skipIf(!url)('admin chat on a real database', () => {
  let prisma: PrismaClient;
  let moderation: ChatModerationDbOperation;
  let modules: ChatModulesDbOperation;
  let money: ChatMoneyDbOperation;
  const roomId = randomUUID();
  const author = randomUUID();
  const reporter = randomUUID();
  const adminId = randomUUID();

  const user = (id: string, name: string) => prisma.$executeRaw`
    INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
    VALUES (${id}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@t.test`}, ${`${name}@t.test`}, ${name})
  `;
  const message = async (text: string): Promise<string> => {
    const id = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO chat.room_messages (id, room_id, user_id, content, type)
      VALUES (${id}::uuid, ${roomId}::uuid, ${author}::uuid, ${text}, 'TEXT')
    `;
    return id;
  };
  const report = async (messageId: string): Promise<string> => {
    const id = randomUUID();
    const [reason] = await prisma.$queryRaw<{ code: string }[]>`
      SELECT code FROM chat.report_reasons ORDER BY sort_order LIMIT 1
    `;
    await prisma.$executeRaw`
      INSERT INTO chat.chat_message_reports (id, message_id, reporter_id, reported_user_id, reason)
      VALUES (${id}::uuid, ${messageId}::uuid, ${reporter}::uuid, ${author}::uuid, ${reason!.code})
    `;
    return id;
  };
  const statusOf = async (reportId: string) =>
    (
      await prisma.$queryRaw<{ status: string; action: string | null }[]>`
        SELECT status::text AS status, action FROM chat.chat_message_reports WHERE id = ${reportId}::uuid
      `
    )[0];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    moderation = new ChatModerationDbOperation(prisma as unknown as PrismaService);
    modules = new ChatModulesDbOperation(prisma as unknown as PrismaService);
    money = new ChatMoneyDbOperation(prisma as unknown as PrismaService);
    const tag = roomId.slice(-8);
    await user(author, `adma${tag}`);
    await user(reporter, `admb${tag}`);
    await prisma.$executeRaw`
      INSERT INTO chat.rooms (id, slug, name, type, config) VALUES (${roomId}::uuid, ${`adm-${tag}`}, 'Admin DB test', 'GLOBAL', '{}')
    `;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  describe('bans end on the database clock', () => {
    it('a timed ban ends the given number of seconds after the database now()', async () => {
      const id = randomUUID();
      const { expiresAt } = await moderation.createBan({
        id,
        userId: author,
        adminId,
        internalReason: 'test',
        seconds: 3600,
      });
      const [row] = await prisma.$queryRaw<{ secs: number }[]>`
        SELECT extract(epoch FROM (expires_at - banned_at))::int AS secs FROM chat.user_bans WHERE id = ${id}::uuid
      `;
      expect(row!.secs).toBe(3600);
      expect(expiresAt).toBeInstanceOf(Date);
    });

    it('a permanent ban has no end, and lifting it works once', async () => {
      const id = randomUUID();
      const { expiresAt } = await moderation.createBan({
        id,
        userId: author,
        adminId,
        internalReason: 'test',
        seconds: null,
      });
      expect(expiresAt).toBeNull();
      expect(await moderation.liftBan(id, adminId)).toEqual({ userId: author, roomId: null });
      expect(await moderation.liftBan(id, adminId)).toBeNull();
    });
  });

  describe('retracting a message', () => {
    it('retracts once, stamped by the database, and never twice', async () => {
      const id = await message('retract me');
      const first = await moderation.retractMessage(id, adminId);
      expect(first).toMatchObject({ roomId, userId: author });
      expect(first!.retractedAt).toBeInstanceOf(Date);
      expect(await moderation.retractMessage(id, adminId)).toBeNull();
    });

    it('keeps the message for staff: nothing is deleted', async () => {
      const id = await message('keep me');
      await moderation.retractMessage(id, adminId);
      const [row] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chat.room_messages WHERE id = ${id}::uuid
      `;
      expect(row!.n).toBe(1);
    });
  });

  describe('resolving a report', () => {
    it('records DISMISSED for a dismissal and keeps the action', async () => {
      const id = await report(await message('dismiss me'));
      expect(await moderation.resolveReport(id, 'DISMISS', adminId)).toBe(true);
      expect(await statusOf(id)).toEqual({ status: 'DISMISSED', action: 'DISMISS' });
    });

    it('records ACTIONED for any other action', async () => {
      const id = await report(await message('warn me'));
      expect(await moderation.resolveReport(id, 'WARN', adminId)).toBe(true);
      expect(await statusOf(id)).toEqual({ status: 'ACTIONED', action: 'WARN' });
    });

    it('resolves a report only while it is pending', async () => {
      const id = await report(await message('once only'));
      expect(await moderation.resolveReport(id, 'DISMISS', adminId)).toBe(true);
      expect(await moderation.resolveReport(id, 'BAN', adminId)).toBe(false);
      expect((await statusOf(id))?.status).toBe('DISMISSED');
    });
  });

  it('shows archived DM content in the admin report list', async () => {
    await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS chat_archive.dm_messages_2000_01
      (LIKE chat.dm_messages INCLUDING ALL)`;
    const dmMessageId = randomUUID();
    const reportId = randomUUID();
    const messageContent = 'archived report evidence';
    const createdAt = new Date('2000-01-15T12:00:00Z');
    const [reason] = await prisma.$queryRaw<{ code: string }[]>`
      SELECT code FROM chat.report_reasons WHERE report_type = 'MESSAGE' AND is_active LIMIT 1
    `;
    await prisma.$executeRaw`
      INSERT INTO chat_archive.dm_messages_2000_01
        (id, conversation_id, sender_id, content, type, metadata, created_at)
      VALUES (${dmMessageId}::uuid, ${randomUUID()}::uuid, ${author}::uuid,
              ${messageContent}, 'TEXT', '{}'::jsonb, ${createdAt}::timestamptz)
    `;
    await prisma.$executeRaw`
      INSERT INTO chat.chat_message_reports
        (id, dm_message_id, dm_message_created_at, reporter_id, reported_user_id, reason, report_type)
      VALUES (${reportId}::uuid, ${dmMessageId}::uuid, ${createdAt}::timestamptz,
              ${reporter}::uuid, ${author}::uuid, ${reason!.code}, 'MESSAGE')
    `;
    const reports = await moderation.getReports({ status: 'PENDING', limit: 100 });
    expect(reports.find((report) => report.id === reportId)).toMatchObject({
      dmMessageId,
      dmMessageArchived: true,
      messageContent,
    });
  });

  describe('Modules 4–5: editing penalties, room access and reverts', () => {
    it('a live ban gets a new end and reason; the old values come back for the log', async () => {
      const id = randomUUID();
      await moderation.createBan({ id, userId: author, adminId, internalReason: 'first', seconds: 3600 });
      const changed = await modules.updateBan(id, { seconds: 7200, internalReason: 'second', userReason: null });
      expect(changed).toMatchObject({ userId: author, old: { internalReason: 'first' } });
      const [row] = await prisma.$queryRaw<{ secs: number; reason: string }[]>`
        SELECT extract(epoch FROM (expires_at - now()))::int AS secs, internal_reason AS reason FROM chat.user_bans WHERE id = ${id}::uuid
      `;
      expect(row!.reason).toBe('second');
      expect(row!.secs).toBeGreaterThan(7190);
      expect((await modules.updateBan(id, { seconds: null, internalReason: null, userReason: null }))?.expiresAt).toBeNull();
      await moderation.liftBan(id, adminId);
      expect(await modules.updateBan(id, { seconds: 60, internalReason: null, userReason: null })).toBeNull();
    });

    it('room access: ADD, REMOVE and RESTORE', async () => {
      const lists = async () =>
        (
          await prisma.$queryRaw<{ excluded: boolean; included: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM chat.room_excluded_users WHERE room_id = ${roomId}::uuid AND user_id = ${author}::uuid AND removed_at IS NULL) AS excluded,
                   EXISTS (SELECT 1 FROM chat.room_included_users WHERE room_id = ${roomId}::uuid AND user_id = ${author}::uuid AND removed_at IS NULL) AS included
          `
        )[0];
      await modules.setRoomAccess(roomId, author, 'REMOVE');
      expect(await lists()).toEqual({ excluded: true, included: false });
      await modules.setRoomAccess(roomId, author, 'ADD');
      expect(await lists()).toEqual({ excluded: false, included: true });
      await modules.setRoomAccess(roomId, author, 'RESTORE');
      expect(await lists()).toEqual({ excluded: false, included: false });
    });

    it('the bot log lists what the system did to a user', async () => {
      await prisma.$executeRaw`
        INSERT INTO chat.moderation_actions (id, actor_type, action, target_user_id)
        VALUES (${randomUUID()}::uuid, 'SYSTEM', 'auto.test', ${author}::uuid)
      `;
      const log = await modules.botLog(author, 10, null);
      expect(log[0]).toMatchObject({ action: 'auto.test', userId: author });
    });

    it('gift reverts: a dry run counts, the real one marks completed gifts in the frame only', async () => {
      const gift = async (usd: string, at: string, currency = 'USDT') => {
        const id = randomUUID();
        await prisma.$executeRaw`
          INSERT INTO chat.gift_transfers (id, sender_id, recipient_id, currency, amount, usd_value, verification, status,
                                           expires_at, created_at)
          VALUES (${id}::uuid, ${author}::uuid, ${reporter}::uuid, ${currency}, ${usd}::numeric, ${usd}::numeric,
                  'TWO_FA', 'COMPLETED', now(), ${at}::timestamptz)
        `;
        return id;
      };
      const inside = await gift('10', '2020-01-02T00:00:00Z');
      const tooBig = await gift('900', '2020-01-02T00:00:00Z');
      const otherCoin = await gift('10', '2020-01-02T00:00:00Z', 'BTC');
      const outside = await gift('10', '2020-02-02T00:00:00Z');
      const filter = {
        from: '2020-01-01T00:00:00Z',
        to: '2020-01-31T00:00:00Z',
        userIds: [author],
        minUsd: null,
        maxUsd: '100',
        currencies: ['USDT'],
        refundFees: true,
        adminId,
      };
      expect(await money.revertGifts({ ...filter, dryRun: true })).toEqual({
        count: 1,
        usd: '10.00',
      });
      expect(await money.revertGifts({ ...filter, dryRun: false })).toEqual({
        count: 1,
        usd: '10.00',
      });
      const rows = await prisma.$queryRaw<
        { id: string; status: string; revert_refund_fees: boolean }[]
      >`
        SELECT id, status, revert_refund_fees FROM chat.gift_transfers
        WHERE id = ANY(${[inside, tooBig, otherCoin, outside]}::uuid[])
      `;
      const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      expect(status[inside]).toBe('REVERT_PENDING');
      expect(rows.find((r) => r.id === inside)?.revert_refund_fees).toBe(true);
      expect([status[tooBig], status[otherCoin], status[outside]]).toEqual([
        'COMPLETED',
        'COMPLETED',
        'COMPLETED',
      ]);
      // Already pending: a second revert finds nothing more.
      expect((await money.revertGifts({ ...filter, dryRun: false })).count).toBe(0);
    });

    it('ad reverts find ads by frame, user and price, and mark their rewards for taking back', async () => {
      const id = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO chat.chat_ads (id, creator_id, content, room_ids, price_usd, status, created_at)
        VALUES (${id}::uuid, ${author}::uuid, 'Buy now', ${[roomId]}::uuid[], 12, 'COMPLETED', '2020-03-02T00:00:00Z')
      `;
      const found = await money.adsForRevert({
        from: '2020-03-01T00:00:00Z',
        to: '2020-03-31T00:00:00Z',
        userIds: [author],
        minUsd: '10',
        maxUsd: null,
        adIds: [],
        pinnedOnly: false,
      });
      expect(found.map((a) => a.id)).toEqual([id]);
      expect(await money.markAdRewardsRevert([id])).toBe(1);
      expect(await money.markAdRewardsRevert([id])).toBe(0);
    });
  });
});
