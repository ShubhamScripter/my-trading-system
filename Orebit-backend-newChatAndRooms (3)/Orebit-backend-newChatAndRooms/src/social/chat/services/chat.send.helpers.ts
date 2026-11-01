/**
 * Two lookups a send needs before the message is stored: which skin it wears, and which tagged users may see the room.
 * Kept out of ChatService so that file stays a readable single path from "send" to "stored".
 */
import type { ChatAccessService } from '../chat.access.service';
import type { ChatDbOperation } from '../chat.dboperation';
import type { SendContext } from '../chat.service';
import type { ChatUserContext, EligibilityFacts, RoomRecord } from '../chat.types';
import type { ChatAccountService } from './chat.account.service';

/** The skin a message wears: the one asked for (it must be usable), else the saved choice if still usable, else none. */
export async function resolveSendSkin(
  db: ChatDbOperation,
  account: ChatAccountService,
  user: ChatUserContext,
  facts: EligibilityFacts,
  explicit: string | undefined,
  context: SendContext,
): Promise<string | null> {
  if (explicit) return (await account.assertSkinUsable(user, explicit)).id;
  const saved =
    context.activeSkinId !== undefined ? context.activeSkinId : (await db.preferences(user.id)).activeSkinId;
  return saved ? ((await account.usableSkin(saved, facts))?.id ?? null) : null;
}

/** Tagged users who may view the room, at most one user query for an open room. */
export async function taggedViewers(
  db: ChatDbOperation,
  access: ChatAccessService,
  room: RoomRecord,
  usernames: readonly string[],
  authorId: string,
): Promise<string[]> {
  if (usernames.length === 0) return [];
  const users = (await db.usersByUsernames(usernames)).filter((u) => u.id !== authorId);
  const openRoom =
    room.type === 'GLOBAL' &&
    room.access.visibility.groups.length === 0 &&
    room.access.visibility.minLevel === 0 &&
    room.config.status === 'ACTIVE';
  if (openRoom) return users.map((u) => u.id);
  const out: string[] = [];
  for (const u of users) {
    const context = await db.findChatUser(u.id);
    if (!context) continue;
    const view = await access.evaluate(context, room);
    if (view.isEligibleToView && view.receivesUserMessages) out.push(u.id);
  }
  return out;
}
