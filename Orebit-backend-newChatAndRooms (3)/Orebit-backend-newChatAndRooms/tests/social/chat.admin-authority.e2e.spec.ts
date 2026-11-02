import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { RESTRICTION_KINDS } from '../../src/social/chat/chat.contract';
import { STAFF_PERMISSIONS } from '../../src/social/chat/chat.features.contract';
import { GLOBAL_ROOM_ID } from '../../src/social/chat/chat.constants';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import { ChatAccessService } from '../../src/social/chat/chat.access.service';
import { ChatDbOperation } from '../../src/social/chat/chat.dboperation';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import { ChatBus } from '../../src/social/chat/realtime/chat.bus';
import { ChatContentService } from '../../src/social/chat/services/chat.content.service';
import { ChatStaffGate } from '../../src/social/chat/services/chat.staff.gate';
import { ChatStaffToolsService } from '../../src/social/chat/services/chat.staff.tools.service';
import { bootChat, makeUsers, refusal, type Emitted } from './chat.e2e.harness';

/**
 * Slice E: what an admin or a higher role can take away from one staff member or user (FR-172), on the REAL services
 * and a migrated scratch database. One restriction kind for each permission that had none: pinning, deleting
 * messages, history, the Staff room, images and videos.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.admin-authority.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const NAMES = ['boss', 'mod', 'ada'] as const;

describe.skipIf(!url)('chat restrictions for every permission (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  let u: Record<(typeof NAMES)[number], ChatUserContext>;
  const document = ChatSettingsDocumentSchema.parse({ global: { testProviders: { enabled: true } } });

  const restrict = async (target: ChatUserContext, kind: (typeof RESTRICTION_KINDS)[number]) => {
    const made = (await module.get(ChatStaffToolsService).restrict(u.boss, {
      targetType: 'USER',
      targetValue: target.username,
      kind,
      internalReason: `Test ${kind}`,
      durationHours: 1,
    })) as { id?: string };
    module.get(ChatBus).publish({ kind: 'restrictions' });
    return made;
  };
  const liftAll = async (target: ChatUserContext) => {
    await prisma.$executeRaw`UPDATE chat.user_restrictions SET lifted_at = now() WHERE target_value = ${target.id} AND lifted_at IS NULL`;
    module.get(ChatBus).publish({ kind: 'restrictions' });
  };

  beforeAll(async () => {
    ({ prisma, module } = await bootChat(url!, emitted, () => document));
    u = await makeUsers(prisma, NAMES, tag);
    await prisma.$executeRaw`INSERT INTO chat.staff_roles (id, user_id, role) VALUES (${uuidv7()}::uuid, ${u.boss.id}::uuid, 'ADMIN'::chat."StaffRole")`;
    await prisma.$executeRaw`INSERT INTO chat.staff_roles (id, user_id, role) VALUES (${uuidv7()}::uuid, ${u.mod.id}::uuid, 'MODERATOR'::chat."StaffRole")`;
    u.boss = { ...u.boss, staffRole: 'ADMIN' };
    u.mod = { ...u.mod, staffRole: 'MODERATOR' };
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  it('the contract has a kind for each of the six permissions, and no permission to assign roles', () => {
    for (const kind of ['RESTRICT_PIN', 'RESTRICT_DELETE_MESSAGES', 'RESTRICT_HISTORY', 'RESTRICT_STAFF_ROOM', 'RESTRICT_IMAGES', 'RESTRICT_VIDEOS']) {
      expect(RESTRICTION_KINDS).toContain(kind);
    }
    expect(STAFF_PERMISSIONS as readonly string[]).not.toContain('ASSIGN_ROLES');
  });

  it('every kind is accepted and stored (the database check allows all of them)', async () => {
    for (const kind of RESTRICTION_KINDS.filter((k) => k !== 'MUTE')) {
      const made = await restrict(u.ada, kind);
      expect(made).toBeTruthy();
    }
    const rows = await prisma.$queryRaw<{ kind: string }[]>`SELECT DISTINCT kind FROM chat.user_restrictions WHERE target_value = ${u.ada.id}`;
    expect(rows.map((r) => r.kind).sort()).toEqual(RESTRICTION_KINDS.filter((k) => k !== 'MUTE').sort());
    await liftAll(u.ada);
  });

  it('RESTRICT_PIN, RESTRICT_DELETE_MESSAGES and RESTRICT_HISTORY take that permission from a moderator who has it', async () => {
    const gate = module.get(ChatStaffGate);
    expect(await refusal(() => gate.mode(u.mod, 'PIN'))).toBe('ok');
    expect(await refusal(() => gate.mode(u.mod, 'DELETE_MESSAGES'))).toBe('ok');
    expect(await refusal(() => gate.requireAct(u.mod, 'SEE_HISTORY'))).toBe('ok');

    await restrict(u.mod, 'RESTRICT_PIN');
    expect(await refusal(() => gate.mode(u.mod, 'PIN'))).toBe('restricted');
    expect(await gate.canAct(u.mod, 'PIN')).toBe(false);
    // The others are untouched.
    expect(await refusal(() => gate.mode(u.mod, 'DELETE_MESSAGES'))).toBe('ok');

    await restrict(u.mod, 'RESTRICT_DELETE_MESSAGES');
    expect(await refusal(() => gate.mode(u.mod, 'DELETE_MESSAGES'))).toBe('restricted');
    await restrict(u.mod, 'RESTRICT_HISTORY');
    expect(await refusal(() => gate.requireAct(u.mod, 'SEE_HISTORY'))).toBe('restricted');

    await liftAll(u.mod);
    expect(await refusal(() => gate.mode(u.mod, 'PIN'))).toBe('ok');
    expect(await refusal(() => gate.requireAct(u.mod, 'SEE_HISTORY'))).toBe('ok');
  });

  it('RESTRICT_STAFF_ROOM shuts the Staff room to that staff member only', async () => {
    const access = module.get(ChatAccessService);
    access.forgetUser(u.mod.id);
    expect((await access.factsFor(u.mod)).staffRoomBlocked).toBe(false);
    await restrict(u.mod, 'RESTRICT_STAFF_ROOM');
    expect((await access.factsFor(u.mod)).staffRoomBlocked).toBe(true);
    // A user nobody restricted, and a staff member nobody restricted, are not blocked.
    expect((await access.factsFor(u.boss)).staffRoomBlocked).toBe(false);
    await liftAll(u.mod);
    expect((await access.factsFor(u.mod)).staffRoomBlocked).toBe(false);
  });

  it('RESTRICT_IMAGES stops images and RESTRICT_VIDEOS stops videos, each without the other', async () => {
    const access = module.get(ChatAccessService);
    const content = module.get(ChatContentService);
    const dbNow = await module.get(ChatDbOperation).dbNow();
    const room = await access.requireRoom(GLOBAL_ROOM_ID);
    const settings = await access.settingsFor(u.ada);
    const send = async (media: 'image' | 'video') =>
      refusal(async () =>
        content.moderate({ user: u.ada, facts: await access.factsFor(u.ada), room, settings, text: '', media, dbNow }),
      );
    const before = { image: await send('image'), video: await send('video') };

    await restrict(u.ada, 'RESTRICT_IMAGES');
    const afterImages = { image: await send('image'), video: await send('video') };
    expect(afterImages.image).toBe('content_blocked');
    expect(afterImages.video).toBe(before.video);
    await liftAll(u.ada);

    await restrict(u.ada, 'RESTRICT_VIDEOS');
    expect(await send('video')).toBe('content_blocked');
    expect(await send('image')).toBe(before.image);
    await liftAll(u.ada);
  });
});
