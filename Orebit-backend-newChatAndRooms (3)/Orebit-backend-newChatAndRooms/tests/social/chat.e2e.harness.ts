import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { RedisService } from '../../redis';
import { SessionService } from '../../auth/services/session.service';
import { TwoFactorService } from '../../src/2fa/2fa.service';
import { MailService } from '../../src/mail/mail.service';
import { SecurityRestrictionRiskEvaluator } from '../../src/restrictions/restrictions.evaluator';
import { SecurityRestrictionService } from '../../src/restrictions/restrictions.service';
import { ProblemException } from '../../src/http';
import { uuidv7 } from '../../src/utils/public.utils';
import { ChatModule } from '../../src/social/chat/chat.module';
import { ChatSettingsService } from '../../src/social/chat/chat.settings';
import { ChatDelivery } from '../../src/social/chat/realtime/chat.delivery';
import type { ChatUserContext } from '../../src/social/chat/chat.types';

/**
 * Stand-ins shared by the chat end-to-end specs (the real services run on a scratch database; only what chat does not
 * own is replaced): Redis in memory, a recording Socket.IO server, and a helper that turns a refusal into its reason.
 */

/**
 * The Redis calls chat makes, in memory: values with an optional expiry (SET ... EX/PX, PEXPIRE), the atomic counter
 * (INCR) and the remaining time (PTTL) that the action limiter uses.
 */
export function memoryRedis() {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const alive = (key: string) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  const expiryOf = (mode?: string, amount?: number): number | null =>
    mode === 'EX' && amount !== undefined ? Date.now() + amount * 1000 : mode === 'PX' && amount !== undefined ? Date.now() + amount : null;
  return {
    get: async (k: string) => alive(k)?.value ?? null,
    mget: async (...keys: string[]) => keys.map((k) => alive(k)?.value ?? null),
    set: async (k: string, v: string, mode?: string, amount?: number) => {
      store.set(k, { value: v, expiresAt: expiryOf(mode, amount) });
      return 'OK';
    },
    del: async (k: string) => (store.delete(k) ? 1 : 0),
    incr: async (k: string) => {
      const entry = alive(k);
      const next = Number(entry?.value ?? 0) + 1;
      store.set(k, { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    },
    pexpire: async (k: string, ms: number) => {
      const entry = alive(k);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + ms;
      return 1;
    },
    pttl: async (k: string) => {
      const entry = alive(k);
      if (!entry) return -2;
      return entry.expiresAt === null ? -1 : Math.max(0, entry.expiresAt - Date.now());
    },
    pipeline: () => {
      const ops: [string, string][] = [];
      const p = {
        set: (k: string, v: string) => {
          ops.push([k, v]);
          return p;
        },
        exec: async () => ops.map(([k, v]) => store.set(k, { value: v, expiresAt: null })),
      };
      return p;
    },
  };
}

export interface Emitted {
  readonly to: string[];
  readonly except: string[];
  readonly event: string;
  readonly payload: unknown;
}

/** A Socket.IO server stand-in that records every emit with its rooms and exclusions. */
export function recordingServer(log: Emitted[]) {
  const chain = (to: string[], except: string[]) => ({
    to: (rooms: string | string[]) => chain([...to, ...([] as string[]).concat(rooms)], except),
    except: (rooms: string | string[]) =>
      chain(to, [...except, ...([] as string[]).concat(rooms)]),
    emit: (event: string, payload: unknown) => {
      log.push({ to, except, event, payload });
      return true;
    },
  });
  return { ...chain([], []), volatile: chain([], []) };
}

/** The refusal reason of a call ("ok" when it succeeded); anything that is not a refusal is rethrown. */
export async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ProblemException) return String(err.extra?.reason ?? err.type);
    throw err;
  }
  return 'ok';
}

/**
 * Chat settings with every value DM and groups need set (V2-44: there are no built-in DM values, so a test that uses
 * DMs sets them, the way an admin must). Spread over the defaults inside `global`.
 */
export const READY = {
  dm: {
    status: 'ACTIVE',
    newDmFollowerCount: 20,
    newDmFollowerWindowHours: 24,
    newDmNonFollowerCount: 20,
    newDmNonFollowerWindowHours: 24,
    strangerMessageCap: 3,
    merchantMessageCap: 3,
    typingEverySeconds: 2,
    membershipNoticeWindowSeconds: 60,
    searchMinLength: 2,
    searchMaxLength: 100,
    maxPinnedPeople: 5,
    maxPinnedMessages: 10,
  },
  groups: {
    memberLimitPublic: 500,
    memberLimitPrivate: 500,
    memberLimitChannel: 5000,
    maxChannelAdmins: 5,
    receiptGroupSize: 100,
    invitesPerWindow: 50,
    inviteWindowHours: 24,
    maxPendingInvitesPerPerson: 10,
    inviteExpiryHours: 168,
  },
  privacy: { lastSeenDefault: 'ALL', quietStart: '22:00', quietEnd: '07:00' },
  // The money-job numbers have no built-in value (V2-64): a test that buys ads sets them, the way an admin must.
  ads: {
    enabled: true,
    pendingPaymentMinutes: 10,
    jobStaleMinutes: 5,
    jobPageSize: 50,
    jobBudgetSeconds: 20,
    repeat: {
      enabled: true,
      minCount: 1,
      maxCount: 10,
      minGapMinutes: 5,
      maxGapMinutes: 1440,
      discountPercent: 5,
      maxDiscountPercent: 30,
      maxDiscountUsd: null,
    },
    pinned: {
      enabled: true,
      pricePerMinute: { kind: 'USD', value: '0.5' },
      maxQueue: 5,
      minMinutes: 5,
      maxMinutes: 120,
    },
  },
  gifts: { enabled: true, processingStaleMinutes: 10 },
  commands: { enabled: true, disabled: [] },
} as const;

/**
 * The real ChatModule providers on a scratch database with only the outside world replaced: Redis in memory, the
 * session service, 2FA, mail and the rain security check. `getDocument` is read on every settings call, so a test
 * changes the settings by changing what it returns. Socket emits are recorded into `emitted`.
 */
export async function bootChat(
  url: string,
  emitted: Emitted[],
  getDocument: () => unknown,
  /** Providers that replace the real ones (a counting Charge or Transfer port), after the module's own. */
  extraProviders: unknown[] = [],
): Promise<{ prisma: PrismaClient; module: TestingModule }> {
  process.env.CHAT_ALLOW_TEST_PROVIDERS = 'true';
  const prisma = new PrismaClient({ datasourceUrl: url });
  const providers = Reflect.getMetadata('providers', ChatModule) as unknown[];
  const module = await Test.createTestingModule({
    providers: [
      ...(providers as never[]),
      { provide: PrismaService, useValue: prisma },
      { provide: RedisService, useValue: memoryRedis() },
      { provide: SessionService, useValue: {} },
      { provide: MailService, useValue: {} },
      { provide: TwoFactorService, useValue: { proveTotpCode: async () => false } },
      { provide: SecurityRestrictionService, useValue: {} },
      { provide: SecurityRestrictionRiskEvaluator, useValue: {} },
      ...(extraProviders as never[]),
    ],
  }).compile();
  (module.get(ChatSettingsService) as unknown as { document: () => Promise<unknown> }).document = async () =>
    getDocument();
  module.get(ChatDelivery).attach(recordingServer(emitted) as never);
  await prisma.$executeRaw`SELECT chat.ensure_message_partitions(3)`;
  return { prisma, module };
}

/** One real account per name (a name plus the run's tag is the username). */
export async function makeUsers<K extends string>(
  prisma: PrismaClient,
  names: readonly K[],
  tag: string,
): Promise<Record<K, ChatUserContext>> {
  const out = {} as Record<K, ChatUserContext>;
  for (const key of names) {
    const id = uuidv7();
    const name = `${key}${tag}`;
    await prisma.$executeRaw`
      INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
      VALUES (${id}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
    `;
    out[key] = { id, username: name, publicCode: name, staffRole: null };
  }
  return out;
}
