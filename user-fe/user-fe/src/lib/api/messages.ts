import { apiFetch, API_BASE, ApiError, csrfHeaders, problemMessage } from "./client";
import type { Message } from "@/types/chat";

interface Envelope<T> {
  data: T;
}

export interface HistoryPage {
  messages: Message[];
  nextCursor: string | null;
}

export async function getHistory(
  roomId: string,
  token: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<HistoryPage> {
  const limit = options.limit ?? 50;
  const cursorQuery = options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : "";
  const res = await apiFetch<Envelope<any>>(
    `/social/chat/rooms/${roomId}/messages?limit=${limit}${cursorQuery}`,
    { token },
  );
  const raw = res.data;
  const messages = Array.isArray(raw) ? raw : (raw?.items ?? raw?.messages ?? []);
  return {
    messages,
    nextCursor: raw?.nextCursor ?? null,
  };
}

export async function retractMessage(
  messageId: string,
  token: string,
  note?: string,
): Promise<{ messageId: string; roomId: string; retractedAt: string }> {
  const res = await apiFetch<Envelope<{ messageId: string; roomId: string; retractedAt: string }>>(
    `/social/chat/messages/${messageId}/retract`,
    {
      method: "POST",
      token,
      body: note ? { note } : {},
      fallbackMessage: "Failed to retract message",
    },
  );
  return res.data;
}

export interface ReportForm {
  reason: string;
  details?: string;
}

export async function reportMessage(
  messageId: string,
  token: string,
  form: ReportForm,
): Promise<unknown> {
  const res = await apiFetch<Envelope<unknown>>(`/social/chat/messages/${messageId}/report`, {
    method: "POST",
    token,
    body: form,
    fallbackMessage: "Failed to submit report",
  });
  return res.data;
}

export async function reportUser(
  userId: string,
  token: string,
  form: ReportForm,
): Promise<unknown> {
  const res = await apiFetch<Envelope<unknown>>(`/social/chat/users/${userId}/report`, {
    method: "POST",
    token,
    body: form,
    fallbackMessage: "Failed to report user",
  });
  return res.data;
}

export async function getReportReasons(token?: string | null): Promise<{ code: string; label: string }[]> {
  const res = await apiFetch<Envelope<{ items: { code: string; label: string }[] }>>("/social/chat/report-reasons", {
    token: token ?? undefined,
  });
  return res.data?.items ?? [];
}

export interface SendMediaPayload {
  roomId: string;
  mediaUrl: string;
  mediaType: "image" | "video" | "gif";
  caption?: string;
  thumbnailUrl?: string;
  skinId?: string;
}

export async function sendMedia(token: string, payload: SendMediaPayload): Promise<unknown> {
  const res = await apiFetch<Envelope<unknown>>("/social/chat/messages/media", {
    method: "POST",
    token,
    body: payload,
  });
  return res.data;
}

export interface UploadedMedia {
  url: string;
  mediaType: "image" | "gif" | "video";
  sizeBytes: number;
}

/** Raw upload — not routed through apiFetch, since FormData needs the browser to
 *  set its own multipart boundary in Content-Type; apiFetch always forces
 *  application/json whenever a body is present. */
export async function uploadMedia(token: string, file: File, roomId?: string | null): Promise<UploadedMedia> {
  const form = new FormData();
  form.append("file", file);

  // The session cookie authenticates the upload (credentials: include) and the CSRF header must go with it.
  const res = await fetch(`${API_BASE}/social/chat/upload${roomId ? `?roomId=${encodeURIComponent(roomId)}` : ""}`, {
    method: "POST",
    headers: csrfHeaders(),
    body: form,
    credentials: "include",
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = problemMessage(data, "Upload failed");
    throw new ApiError(res.status, message, data);
  }
  return (data.data ?? data) as UploadedMedia;
}

export async function getMentionsFeed(token: string, limit = 30): Promise<{ messages: Message[] }> {
  const res = await apiFetch<Envelope<{ items?: Array<{ message: Message }> }>>(`/social/chat/tags?limit=${limit}`, {
    token,
  });
  return { messages: (res.data?.items ?? []).map((item) => item.message) };
}

// ─── Module 4: pinned messages and my warnings ───────────────────────────────

/** The messages chat staff pinned in a room, newest pin first. */
export async function getPinnedMessages(roomId: string, token?: string | null): Promise<Message[]> {
  const res = await apiFetch<Envelope<{ items?: Message[] }>>(
    `/social/chat/rooms/${encodeURIComponent(roomId)}/pinned?limit=20`,
    { token: token ?? undefined },
  );
  return res.data?.items ?? [];
}

/**
 * Staff "Pin Messages in Chat Rooms". A role that only has REPORT answers `{ requested: true }`: a higher role decides.
 */
export async function setMessagePinned(
  messageId: string,
  pinned: boolean,
  note?: string,
): Promise<{ requested?: boolean; isPinned?: boolean }> {
  const res = await apiFetch<Envelope<{ requested?: boolean; isPinned?: boolean }>>(
    `/social/chat/messages/${messageId}/${pinned ? "pin" : "unpin"}`,
    { method: "POST", body: note ? { note } : {}, fallbackMessage: pinned ? "Could not pin" : "Could not unpin" },
  );
  return res.data ?? {};
}

export interface MyWarning {
  id: string;
  roomId: string | null;
  reason: string;
  createdAt: string;
}

/** The warnings I received (never who issued them). */
export async function getMyWarnings(limit = 50): Promise<MyWarning[]> {
  const res = await apiFetch<Envelope<{ items?: MyWarning[] }>>(`/social/chat/warnings?limit=${limit}`, {
    fallbackMessage: "Could not load your warnings",
  });
  return res.data?.items ?? [];
}
