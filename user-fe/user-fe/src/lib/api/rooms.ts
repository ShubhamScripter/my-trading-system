import { apiFetch } from "./client";
import type { RoomItem, OnlineUser, RoomRules, SkinItem } from "@/types/chat";

interface Envelope<T> {
  data: T;
}

export async function getRooms(token: string): Promise<RoomItem[]> {
  return (await getRoomList(token)).items;
}

/** The rooms the user may see, plus the GIF provider the admin chose (D-29). */
export async function getRoomList(
  token: string,
): Promise<{ items: RoomItem[]; gifProvider: "TENOR" | "GIPHY" | null }> {
  const res = await apiFetch<Envelope<RoomItem[] | { items: RoomItem[]; gifProvider?: "TENOR" | "GIPHY" }>>(
    "/social/chat/rooms?limit=100",
    { token },
  );
  const raw = res.data;
  if (Array.isArray(raw)) return { items: raw, gifProvider: null };
  return { items: raw?.items || [], gifProvider: raw?.gifProvider ?? null };
}

export async function getRoomOnlineUsers(
  roomId: string,
  token: string,
): Promise<{ count: number; users: OnlineUser[] }> {
  try {
    const res = await apiFetch<Envelope<any>>(
      `/social/chat/rooms/${roomId}/users`,
      { token },
    );
    const raw = res.data;
    const users = Array.isArray(raw) ? raw : (raw?.items ?? raw?.users ?? []);
    const count = typeof raw?.count === 'number' ? raw.count : users.length;
    return { count, users };
  } catch {
    return { count: 0, users: [] };
  }
}

export interface ChatPreferences {
  /** The room that opens: last room kept on the server, else the admin's default (D-17). */
  effectiveDefaultRoomId?: string;
  activeSkinId?: string | null;
  hideIdentity?: boolean;
  /** Chat staff role assigned in the admin panel (null = none). */
  staffRole?: "ADMIN" | "MODERATOR" | "SUPPORT" | null;
}

export async function getPreferences(token: string): Promise<ChatPreferences> {
  const res = await apiFetch<Envelope<ChatPreferences>>("/social/chat/preferences", { token });
  return res.data;
}

export async function updatePreferences(
  token: string,
  updates: Partial<Pick<ChatPreferences, "activeSkinId" | "hideIdentity">>,
): Promise<ChatPreferences> {
  const res = await apiFetch<Envelope<ChatPreferences>>("/social/chat/preferences", {
    method: "PUT",
    token,
    body: updates,
  });
  return res.data;
}

export async function getRoomRules(roomId: string, token?: string | null): Promise<RoomRules> {
  const res = await apiFetch<Envelope<RoomRules>>(`/social/chat/rooms/${roomId}/rules`, {
    token: token ?? undefined,
  });
  return res.data;
}

export async function getSkins(token?: string | null): Promise<SkinItem[]> {
  const res = await apiFetch<Envelope<{ items: SkinItem[] } | SkinItem[]>>('/social/chat/skins', {
    token: token ?? undefined,
  });
  const data = res.data;
  return Array.isArray(data) ? data : (data as any)?.items || [];
}

export const getCosmetics = getSkins;


/** A user's chat profile card (M1-14). `publicCode` is present only on the viewer's own card (D-20). */
export interface ProfileCard {
  id: string;
  username: string;
  publicCode?: string;
  avatarUrl: string | null;
  country: string | null;
  isStaff: boolean;
  badges?: { premium: boolean; kycVerified: boolean };
  isOnline: boolean;
  lastSeenAt: string | null;
  memberSince: string;
}

export async function getProfile(token: string, handle: string): Promise<ProfileCard> {
  const res = await apiFetch<Envelope<ProfileCard>>(`/social/chat/users/${encodeURIComponent(handle)}/profile`, { token });
  return res.data;
}
