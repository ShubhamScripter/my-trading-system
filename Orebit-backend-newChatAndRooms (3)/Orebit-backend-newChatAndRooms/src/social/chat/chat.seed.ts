/**
 * Chat development data: wipe, seed and unseed (demo rooms exist only in a development seed).
 *
 *   npx tsx --env-file=.env src/social/chat/chat.seed.ts clean    every chat row and chat Redis key; accounts stay
 *   npx tsx --env-file=.env src/social/chat/chat.seed.ts seed     base data + demo rooms (idempotent)
 *   npx tsx --env-file=.env src/social/chat/chat.seed.ts unseed   removes exactly what `seed` adds
 *   npx tsx --env-file=.env src/social/chat/chat.seed.ts reset    clean, then seed
 *
 * Only the `chat` schema and `chat:*` Redis keys are touched. User accounts (identity schema), admin accounts
 * (admin schema), sessions and the auth's Redis keys are never touched. Refused when NODE_ENV is production.
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

/** Every chat table (the partitioned messages table takes its partitions with it). */
const CHAT_TABLES = [
  'chat_message_reports',
  'chat_warnings',
  'client_message_ids',
  'frequent_hitters',
  'limit_hits_hourly',
  'media_uploads',
  'message_cosmetics',
  'message_mentions',
  'moderation_actions',
  'moderation_offences',
  'regions',
  'report_reasons',
  'room_access_rules',
  'room_excluded_users',
  'room_included_users',
  'room_messages',
  'rooms',
  'runtime_stats',
  'settings',
  'settings_changes',
  'staff_roles',
  'test_entitlements',
  'user_bans',
  'group_warnings',
  'user_chat_preferences',
  // Module 4
  'user_restrictions',
  'staff_requests',
  // Module 5
  'user_mutes',
  'user_blocks',
  'chat_commands',
  'chat_ads',
  'chat_ad_placements',
  'gift_transfers',
  // The ads status last acted on (a missing row reads as ACTIVE) and the reverts by group of users.
  'ads_state',
  'money_revert_jobs',
  // Modules 8–9
  'dm_conversations',
  'dm_members',
  'dm_messages',
  // The partition that catches a row no month partition covers, and the retry ids of DM sends.
  'dm_messages_default',
  'dm_message_dedupe',
  // Where the live DM messages start; the archive function writes it again.
  'archive_state',
  'dm_groups',
  'dm_group_invites',
  'dm_group_bans',
  'dm_ownership_transfers',
  // Module 10
  'support_tickets',
  'support_messages',
] as const;

type RoomSeed = {
  id: string;
  slug: string;
  name: string;
  description: string;
  type: 'GLOBAL' | 'COUNTRY' | 'PREMIUM' | 'KYC' | 'CASINO' | 'SO' | 'STAFF';
  config?: Record<string, unknown>;
  access?: {
    allowedCountries?: string[];
    requirePremium?: boolean;
    minKycLevel?: number;
    minWagerUsd?: string | null;
    ineligibleMode?: 'VIEW_ONLY' | 'HIDE' | 'PROMO_ONLY';
  };
};

/** Global and Staff keep the ids the migration gives them; demo rooms use fixed ids so `unseed` finds them. */
const ROOMS: RoomSeed[] = [
  {
    id: '00000000-0000-0000-0000-000000000000',
    slug: 'global',
    name: 'Global Chat',
    description: 'The global public room, open to every signed-in user.',
    type: 'GLOBAL',
    // Development data: commands and ads on in Global so Module 5 can be tried at once.
    config: { contentControls: { allowCommands: true, allowAds: true } },
  },
  {
    id: '00000000-0000-0000-0000-000000000110',
    slug: 'staff-room',
    name: 'Staff Room',
    description: 'Coordination room for chat staff.',
    type: 'STAFF',
    access: { ineligibleMode: 'HIDE' },
  },
  {
    id: '00000000-0000-0000-0000-00000000d001',
    slug: 'usa-hub',
    name: 'USA Hub',
    description: 'Country room for the United States.',
    type: 'COUNTRY',
    access: { allowedCountries: ['US'] },
  },
  {
    id: '00000000-0000-0000-0000-00000000d002',
    slug: 'india-hub',
    name: 'India Hub',
    description: 'Country room for India.',
    type: 'COUNTRY',
    access: { allowedCountries: ['IN'] },
  },
  {
    id: '00000000-0000-0000-0000-00000000d003',
    slug: 'premium-lounge',
    name: 'Premium Lounge',
    description: 'For users with any active premium plan.',
    type: 'PREMIUM',
    access: { requirePremium: true },
  },
  {
    id: '00000000-0000-0000-0000-00000000d004',
    slug: 'kyc-hub',
    name: 'KYC Verified Hub',
    description: 'For KYC-verified users.',
    type: 'KYC',
    access: { minKycLevel: 1 },
  },
  {
    id: '00000000-0000-0000-0000-00000000d005',
    slug: 'casino-arena',
    name: 'Casino Arena',
    description: 'For users on OREBiT Play with the minimum wager.',
    type: 'CASINO',
    config: { casino: { onlyUsersOnCasino: true } },
    access: { minWagerUsd: '10' },
  },
  {
    id: '00000000-0000-0000-0000-00000000d006',
    slug: 'merchant-so',
    name: 'Merchant & Site Owners',
    description: 'For site owners.',
    type: 'SO',
    access: { ineligibleMode: 'HIDE' },
  },
];

const SKINS = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Standard Gold Glow',
    styleConfig: { badge: '🌟', border: '1px solid #FFD700', textColor: '#FFD700' },
  },
];

const REPORT_REASONS = [
  ['SPAM', 'Spam', 10],
  ['HARASSMENT', 'Harassment', 20],
  ['INAPPROPRIATE', 'Inappropriate content', 30],
  ['SCAM', 'Scam or fraud', 40],
  ['HATE_SPEECH', 'Hate speech', 50],
  ['OTHER', 'Other', 60],
] as const;

/** The access rule id of a seeded room: its own fixed id (room ...xxxxxxxxNNNN -> rule ...0000000eNNNN), unique per room. */
const ruleId = (roomId: string): string => `00000000-0000-0000-0000-0000000e${roomId.slice(-4)}`;

async function clearChatRedis(redis: Redis): Promise<number> {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'chat:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) removed += await redis.del(...keys);
  } while (cursor !== '0');
  return removed;
}

async function clean(prisma: PrismaClient, redis: Redis): Promise<void> {
  // TRUNCATE does not fire the append-only row trigger on moderation_actions; a dev wipe is the one time that is wanted.
  const list = CHAT_TABLES.map((t) => `"chat"."${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY`);
  const keys = await clearChatRedis(redis);
  console.log(
    `clean: emptied ${CHAT_TABLES.length} chat tables, removed ${keys} chat Redis keys (accounts untouched)`,
  );
}

async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO chat.settings (id) VALUES (1) ON CONFLICT DO NOTHING`;
    await tx.$executeRaw`INSERT INTO chat.runtime_stats (id) VALUES (1) ON CONFLICT DO NOTHING`;
    for (const [code, label, order] of REPORT_REASONS) {
      await tx.$executeRaw`INSERT INTO chat.report_reasons (code, label, sort_order) VALUES (${code}, ${label}, ${order}) ON CONFLICT DO NOTHING`;
    }
    for (const skin of SKINS) {
      await tx.$executeRaw`
        INSERT INTO chat.message_cosmetics (id, name, style_config, cost, is_premium, is_active)
        VALUES (${skin.id}::uuid, ${skin.name}, ${JSON.stringify(skin.styleConfig)}::jsonb, 0, false, true)
        ON CONFLICT (id) DO NOTHING`;
    }
    for (const room of ROOMS) {
      // ON CONFLICT DO NOTHING without a target: an existing id OR slug leaves the admin's room alone.
      await tx.$executeRaw`
        INSERT INTO chat.rooms (id, slug, name, description, type, config)
        VALUES (${room.id}::uuid, ${room.slug}, ${room.name}, ${room.description}, ${room.type}::chat."RoomType",
                ${JSON.stringify({ status: 'ACTIVE', ...(room.config ?? {}) })}::jsonb)
        ON CONFLICT DO NOTHING`;
      const a = room.access ?? {};
      await tx.$executeRaw`
        INSERT INTO chat.room_access_rules
          (id, room_id, allowed_countries, require_premium, min_kyc_level, min_wager_usd, ineligible_mode)
        SELECT ${ruleId(room.id)}::uuid, ${room.id}::uuid, ${a.allowedCountries ?? []}::char(2)[], ${a.requirePremium ?? false},
               ${a.minKycLevel ?? 0}, ${a.minWagerUsd ?? null}::numeric, ${a.ineligibleMode ?? 'VIEW_ONLY'}::chat."IneligibleMode"
        WHERE EXISTS (SELECT 1 FROM chat.rooms WHERE id = ${room.id}::uuid)
          AND NOT EXISTS (SELECT 1 FROM chat.room_access_rules WHERE room_id = ${room.id}::uuid)`;
    }
  });
  console.log(
    `seed: settings, stats, ${REPORT_REASONS.length} report reasons, ${SKINS.length} skin, ${ROOMS.length} rooms (Global, Staff + demo)`,
  );
}

async function unseed(prisma: PrismaClient): Promise<void> {
  const roomIds = ROOMS.map((r) => r.id);
  await prisma.$transaction(async (tx) => {
    // Everything that hangs off the seeded rooms and their messages goes first.
    await tx.$executeRaw`DELETE FROM chat.chat_message_reports r USING chat.room_messages m WHERE m.id = r.message_id AND m.room_id = ANY(${roomIds}::uuid[])`;
    await tx.$executeRaw`DELETE FROM chat.client_message_ids c USING chat.room_messages m WHERE m.id = c.message_id AND m.room_id = ANY(${roomIds}::uuid[])`;
    await tx.$executeRaw`DELETE FROM chat.message_mentions WHERE room_id = ANY(${roomIds}::uuid[])`;
    await tx.$executeRaw`DELETE FROM chat.room_messages WHERE room_id = ANY(${roomIds}::uuid[])`;
    await tx.$executeRaw`DELETE FROM chat.user_bans WHERE room_id = ANY(${roomIds}::uuid[])`;
    await tx.$executeRaw`DELETE FROM chat.chat_warnings WHERE room_id = ANY(${roomIds}::uuid[])`;
    await tx.$executeRaw`DELETE FROM chat.chat_ad_placements WHERE room_id = ANY(${roomIds}::uuid[])`;
    await tx.$executeRaw`DELETE FROM chat.user_restrictions WHERE room_id = ANY(${roomIds}::uuid[])`;
    await tx.$executeRaw`DELETE FROM chat.rooms WHERE id = ANY(${roomIds}::uuid[])`;
    await tx.$executeRaw`UPDATE chat.user_chat_preferences SET active_cosmetic_id = NULL WHERE active_cosmetic_id = ANY(${SKINS.map((s) => s.id)}::uuid[])`;
    await tx.$executeRaw`DELETE FROM chat.message_cosmetics WHERE id = ANY(${SKINS.map((s) => s.id)}::uuid[])`;
    await tx.$executeRaw`DELETE FROM chat.report_reasons WHERE code = ANY(${REPORT_REASONS.map((r) => r[0])}::text[])`;
    await tx.$executeRaw`DELETE FROM chat.runtime_stats WHERE id = 1`;
    await tx.$executeRaw`DELETE FROM chat.settings WHERE id = 1`;
  });
  console.log(
    'unseed: removed the seeded rooms (and their messages), skin, report reasons, settings and stats rows',
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!['clean', 'seed', 'unseed', 'reset'].includes(command ?? '')) {
    console.error('usage: chat.seed.ts clean | seed | unseed | reset');
    process.exit(2);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('refused: chat.seed.ts never runs in production');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });
  try {
    if (command === 'clean' || command === 'reset') {
      await redis.connect();
      await clean(prisma, redis);
    }
    if (command === 'seed' || command === 'reset') await seed(prisma);
    if (command === 'unseed') await unseed(prisma);
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('chat.seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
