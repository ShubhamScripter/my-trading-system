import {
  AdminRoom,
  ChatReport,
  UserBan,
  ChatSkin,
  BroadcastPayload,
  PlatformStats,
  AdminUser,
  ChatRegion,
  MediaUpload,
  ChatStaffRole,
  FrequentHitter,
  SettingsChange,
  ReportReasonItem,
} from '../types';

export const API_BASE = 'http://localhost:3002/social/chat';
const AUTH_BASE = 'http://localhost:3002/auth';
const TWO_FA_BASE = 'http://localhost:3002/2fa';
const SESSION_STORAGE_KEY = 'orebit_admin_session';
const CSRF_STORAGE_KEY = 'orebit_admin_csrf_token';

export type LoginStepOutcome =
  | { outcome: 'email_otp_required'; loginId: string; otpExpiresAt: string | null; resendAvailableAt: string | null; otpSendsRemaining: number }
  | { outcome: 'mfa_required'; loginId: string; methods: ('TOTP' | 'PASSKEY')[] }
  | { outcome: 'enrollment_required'; loginId: string; methods: ('TOTP' | 'PASSKEY')[] }
  | { outcome: 'session'; session: { admin: AdminUser; csrfToken: string; refreshExpiresAt: string; reauthenticateAt: string } };

export type TotpEnrollOutcome = { outcome: 'totp_enrollment'; totp: { secret: string; uri: string; replacing: boolean } };

function csrfHeader(): Record<string, string> {
  const stored = localStorage.getItem(CSRF_STORAGE_KEY);
  if (stored) return { 'x-csrf-token': stored };
  const match = document.cookie.match(/(?:^|;\s*)orebit_admin_csrf=([^;]+)/);
  return match ? { 'x-csrf-token': decodeURIComponent(match[1]) } : {};
}

function storeSession(session: { admin: { id: string; email: string; name: string; role: AdminUser['role'] }; csrfToken: string }): AdminUser {
  const user: AdminUser = {
    id: session.admin.id,
    email: session.admin.email,
    name: session.admin.name,
    role: session.admin.role,
    token: '',
    lastLoginAt: new Date().toISOString(),
  };
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(user));
  if (session.csrfToken) localStorage.setItem(CSRF_STORAGE_KEY, session.csrfToken);
  return user;
}

export async function postJson(url: string, body: unknown): Promise<{ success: boolean; error?: string; [key: string]: any }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const { detail, title, ...extra } = (json ?? {}) as Record<string, unknown>;
      delete extra.type;
      return { success: false, error: (detail as string) || (title as string) || `Request failed (${res.status})`, ...extra };
    }
    const payload = (json?.data ?? json ?? {}) as Record<string, unknown>;
    return { ...payload, success: true };
  } catch (err: any) {
    return { success: false, error: 'Network error: ' + (err?.message || 'unreachable') };
  }
}

export async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { credentials: 'include' });
  const data = await res.json();
  return data;
}

export const AdminAPI = {
  // Auth Session Management
  getCurrentAdmin(): AdminUser | null {
    try {
      const data = localStorage.getItem(SESSION_STORAGE_KEY);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  completeSession(session: { admin: { id: string; email: string; name: string; role: AdminUser['role'] }; csrfToken: string }): AdminUser {
    return storeSession(session);
  },

  async loginWithPassword(email: string, password: string): Promise<{ success: boolean; error?: string } & Partial<LoginStepOutcome>> {
    return postJson(`${AUTH_BASE}/login`, {
      step: 'password',
      email: email.trim().toLowerCase(),
      password: password.trim(),
    });
  },

  async verifyEmailOtp(loginId: string, code: string): Promise<{ success: boolean; error?: string } & Partial<LoginStepOutcome>> {
    return postJson(`${AUTH_BASE}/login`, { step: 'verify-email', loginId, code: code.trim() });
  },

  async resendOtp(loginId: string): Promise<{ success: boolean; error?: string } & Partial<LoginStepOutcome>> {
    return postJson(`${AUTH_BASE}/login`, { step: 'resend-otp', loginId });
  },

  async totpEnroll(loginId: string): Promise<{ success: boolean; error?: string } & Partial<TotpEnrollOutcome>> {
    return postJson(TWO_FA_BASE, { action: 'totp-enroll', loginId });
  },

  async totpVerify(loginId: string, code: string): Promise<{ success: boolean; admin?: AdminUser; error?: string }> {
    const res = await postJson(TWO_FA_BASE, { action: 'totp-verify', loginId, code: code.trim() });
    if (!res.success) return { success: false, error: res.error };
    const session = res.session;
    if (!session?.admin) return { success: false, error: 'Sign-in did not return a session' };
    return { success: true, admin: storeSession(session) };
  },

  async logout(): Promise<void> {
    try {
      await fetch(`${AUTH_BASE}/session`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ action: 'logout' }),
      });
    } catch {
      // swallow network errors on logout
    } finally {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      localStorage.removeItem(CSRF_STORAGE_KEY);
    }
  },

  // Stats
  async getStats(): Promise<PlatformStats> {
    try {
      const data = await getJson(`${API_BASE}/stats`);
      const payload = data?.data || data;
      return (
        payload.stats || {
          totalRooms: 0,
          activeRooms: 0,
          totalOnlineUsers: 0,
          totalMessages: 0,
          pendingReports: 0,
          activeBans: 0,
          totalCosmetics: 0,
        }
      );
    } catch {
      return {
        totalRooms: 0,
        activeRooms: 0,
        totalOnlineUsers: 0,
        totalMessages: 0,
        pendingReports: 0,
        activeBans: 0,
        totalCosmetics: 0,
      };
    }
  },

  // Rooms
  async getRooms(): Promise<AdminRoom[]> {
    try {
      const data = await getJson(`${API_BASE}/rooms`);
      const payload = data?.data || data;
      return payload.rooms || [];
    } catch {
      return [];
    }
  },

  /**
   * The room modal's "/rain", "/gift", "/pm", "/ad", "/mute" chips as the backend's command names ("rain", "send", "dm",
   * "ad", "mute"). Commands without a chip (help, unmute, block…) stay allowed, so switching a chip off only takes
   * that command away in the room.
   */
  roomCommands(allowed: unknown): string[] | undefined {
    if (!Array.isArray(allowed)) return undefined;
    const alias: Record<string, string> = { gift: 'send', pm: 'dm' };
    const chips = ['rain', 'send', 'dm', 'ad', 'mute'];
    const always = ['help', 'unmute', 'mutelist', 'block', 'unblock', 'blocklist'];
    const names = allowed.map((c) => String(c).replace(/^\//, '').toLowerCase()).map((c) => alias[c] ?? c);
    return [...always, ...new Set(names.filter((c) => chips.includes(c)))];
  },

  async createRoom(roomData: Record<string, any>) {
    // Sanitize payload to match CreateRoomSchema strictly
    const payload: Record<string, any> = {
      name: roomData.name?.trim(),
      type: roomData.type || 'GLOBAL',
      status: roomData.status || 'ACTIVE',
      rules: Array.isArray(roomData.rules) ? roomData.rules : [],
      bannedWords: Array.isArray(roomData.bannedWords) ? roomData.bannedWords : [],
    };
    if (roomData.slug) payload.slug = roomData.slug.toLowerCase().trim();
    if (roomData.description) payload.description = roomData.description.trim();
    if (roomData.language) payload.language = roomData.language.trim();
    if (roomData.statusNote) payload.statusNote = roomData.statusNote.trim();
    if (roomData.statusUntil) payload.statusUntil = roomData.statusUntil;
    if (roomData.linksPolicy) payload.linksPolicy = roomData.linksPolicy;
    if (roomData.contentControls) {
      payload.contentControls = { ...roomData.contentControls };
      const commands = AdminAPI.roomCommands(roomData.allowedCommands);
      if (roomData.contentControls.allowCommands && commands) payload.contentControls.commands = commands;
    }
    if (roomData.access) payload.access = roomData.access;
    if (roomData.casino) payload.casino = roomData.casino;
    return postJson(`${API_BASE}/rooms`, payload);
  },

  async updateRoom(roomData: Record<string, any>) {
    const payload: Record<string, any> = {
      roomId: roomData.roomId || roomData.id,
    };
    if (roomData.name) payload.name = roomData.name.trim();
    if (roomData.slug) payload.slug = roomData.slug.toLowerCase().trim();
    if (roomData.description !== undefined) payload.description = roomData.description?.trim() || null;
    if (roomData.type) payload.type = roomData.type;
    if (roomData.status) payload.status = roomData.status;
    if (roomData.statusNote !== undefined) payload.statusNote = roomData.statusNote?.trim() || null;
    if (roomData.statusUntil !== undefined) payload.statusUntil = roomData.statusUntil || null;
    if (roomData.language !== undefined) payload.language = roomData.language?.trim() || null;
    if (roomData.rules) payload.rules = roomData.rules;
    if (roomData.bannedWords) payload.bannedWords = roomData.bannedWords;
    if (roomData.linksPolicy !== undefined) payload.linksPolicy = roomData.linksPolicy;
    if (roomData.contentControls) {
      payload.contentControls = { ...roomData.contentControls };
      const commands = AdminAPI.roomCommands(roomData.allowedCommands);
      if (roomData.contentControls.allowCommands && commands) payload.contentControls.commands = commands;
    }
    // The access rule has its own super-admin route; the room update refuses it.
    if (roomData.casino !== undefined) payload.casino = roomData.casino;
    if (Array.isArray(roomData.controlsMaintenance)) payload.controlsMaintenance = roomData.controlsMaintenance;
    // "Schedule room status / controls": a later time queues the change instead of applying it now.
    if (roomData.effectiveAt) payload.effectiveAt = new Date(roomData.effectiveAt).toISOString();
    const updated = await postJson(`${API_BASE}/rooms/update`, payload);
    if (roomData.access && Object.keys(roomData.access).length > 0) {
      await postJson(`${API_BASE}/rooms/access`, { roomId: payload.roomId, access: roomData.access });
    }
    return updated;
  },

  async deleteRoom(roomId: string) {
    return postJson(`${API_BASE}/rooms/delete`, { roomId });
  },

  // Rules
  async getRules(roomId: string): Promise<{ roomId: string; roomName: string; rules: string[] }> {
    const data = await getJson(`${API_BASE}/rules?roomId=${roomId}`);
    return data?.data || data;
  },

  async updateRules(roomId: string, rules: string[]) {
    return postJson(`${API_BASE}/rules`, { roomId, rules });
  },

  // Reports
  async getReports(status = 'ALL', before?: string, limit = 50): Promise<ChatReport[]> {
    try {
      const query = new URLSearchParams();
      if (status && status !== 'ALL') query.set('status', status);
      if (before) query.set('before', before);
      if (limit) query.set('limit', String(limit));
      const qs = query.toString() ? `?${query.toString()}` : '';
      const data = await getJson(`${API_BASE}/reports${qs}`);
      const payload = data?.data || data;
      return payload.reports || [];
    } catch {
      return [];
    }
  },

  async actionReport(reportId: string, action: string, reason?: string, banDurationHours?: number, banPermanent?: boolean) {
    return postJson(`${API_BASE}/reports/action`, {
      reportId,
      action,
      note: reason?.trim() || 'Report action processed by admin',
      ...(action === 'BAN' ? (banPermanent ? { banPermanent: true } : { banDurationHours: banDurationHours ?? 24 }) : {}),
    });
  },

  // Report Reasons
  async getReportReasons(): Promise<ReportReasonItem[]> {
    try {
      const data = await getJson(`${API_BASE}/report-reasons`);
      const payload = data?.data || data;
      return payload.reasons || [];
    } catch {
      return [];
    }
  },

  async upsertReportReason(reason: ReportReasonItem) {
    return postJson(`${API_BASE}/report-reasons`, reason);
  },

  // Bans
  async getBans(userId?: string, activeOnly = false, before?: string, limit = 50): Promise<UserBan[]> {
    try {
      const query = new URLSearchParams();
      if (userId) query.set('userId', userId);
      if (activeOnly) query.set('activeOnly', 'true');
      if (before) query.set('before', before);
      if (limit) query.set('limit', String(limit));
      const qs = query.toString() ? `?${query.toString()}` : '';
      const data = await getJson(`${API_BASE}/bans${qs}`);
      const payload = data?.data || data;
      return payload.bans || [];
    } catch {
      return [];
    }
  },

  async createBan(banData: {
    userId: string;
    reason: string;
    note?: string;
    durationHours?: number;
    permanent?: boolean;
    roomId?: string | null;
  }) {
    return postJson(`${API_BASE}/bans`, {
      userId: banData.userId.trim(),
      internalReason: (banData.note?.trim() || banData.reason.trim()),
      ...(banData.reason.trim() ? { userReason: banData.reason.trim() } : {}),
      ...(banData.permanent ? { permanent: true } : { durationHours: banData.durationHours ?? 24 }),
      roomId: banData.roomId || null,
    });
  },

  /** Lifts a ban via POST /bans/lift with a required note (CH-046, CH-090). */
  async unbanUser(banId: string, note?: string) {
    return postJson(`${API_BASE}/bans/lift`, {
      banId,
      note: note?.trim() || 'Ban lifted by administrator',
    });
  },

  // Skins (formerly cosmetics, CH-074, D-44)
  async getSkins(): Promise<ChatSkin[]> {
    try {
      const data = await getJson(`${API_BASE}/skins`);
      const payload = data?.data || data;
      return payload.skins || [];
    } catch {
      return [];
    }
  },

  async createSkin(skinData: {
    name: string;
    description?: string;
    gradient: string;
    borderColor: string;
    badgeIcon: string;
    cost?: string | number;
    isPremium?: boolean;
  }) {
    return postJson(`${API_BASE}/skins`, {
      name: skinData.name.trim(),
      description: skinData.description?.trim() || '',
      gradient: skinData.gradient.trim(),
      borderColor: skinData.borderColor.trim(),
      badgeIcon: skinData.badgeIcon.trim(),
      cost: String(skinData.cost ?? '0').trim(),
      isPremium: Boolean(skinData.isPremium),
    });
  },

  async deactivateSkin(id: string) {
    return postJson(`${API_BASE}/skins/deactivate`, { id });
  },

  // Aliases for backwards compatibility with existing views
  getCosmetics(): Promise<ChatSkin[]> {
    return this.getSkins();
  },
  createCosmetic(cosmeticData: any) {
    return this.createSkin(cosmeticData);
  },
  /** Makes a deactivated skin selectable again (CH-074). */
  async activateCosmetic(id: string) {
    return postJson(`${API_BASE}/skins/activate`, { id });
  },

  deleteCosmetic(id: string) {
    return this.deactivateSkin(id);
  },

  // Broadcast
  async sendBroadcast(payload: BroadcastPayload) {
    return postJson(`${API_BASE}/broadcast`, {
      roomId: payload.roomId || null,
      type: payload.type || 'ADMIN_ALERT',
      title: payload.title.trim(),
      content: payload.content.trim(),
      priority: payload.priority || 'NORMAL',
    });
  },

  // Chat History (cursor-based pagination, CH-037, CH-045)
  async getChatHistory(
    roomId: string,
    limit = 50,
    before?: string,
  ): Promise<{ messages: any[]; nextCursor: string | null }> {
    try {
      const query = new URLSearchParams({ roomId, limit: String(limit) });
      if (before) query.set('before', before);
      const data = await getJson(`${API_BASE}/history?${query.toString()}`);
      const payload = data?.data || data;
      return payload || { messages: [], nextCursor: null };
    } catch {
      return { messages: [], nextCursor: null };
    }
  },

  // Retract a message (admin, note required, CH-090)
  async retractMessage(messageId: string, note?: string): Promise<{ success: boolean; error?: string }> {
    return postJson(`${API_BASE}/retract`, {
      messageId,
      note: note?.trim() || 'Retracted by moderation administrator',
    });
  },

  // Moderation log (CH-018): every admin, staff and auto-moderation action, newest first.
  async getModerationActions(): Promise<any[]> {
    try {
      const data = await getJson(`${API_BASE}/actions?limit=100`);
      return (data?.data || data)?.actions || [];
    } catch {
      return [];
    }
  },

  // Moderation Settings
  async getModerationSettings(roomId: string): Promise<any> {
    try {
      const data = await getJson(`${API_BASE}/moderation/settings?roomId=${roomId}`);
      return data?.data || data;
    } catch {
      return null;
    }
  },

  async saveModerationSettings(roomId: string, settings: any): Promise<{ success: boolean }> {
    // Only the keys chat enforces: the server refuses anything else. A stored entry keeps its expiry, a new one
    // says how long it lasts, and an entry without a duration is permanent.
    const entry = (r: any) => ({
      targetType: r.targetType,
      targetValue: r.targetValue,
      restriction: r.restriction,
      internalReason: r.internalReason,
      ...(r.userReason ? { userReason: r.userReason } : {}),
      ...(r.commands?.length ? { commands: r.commands } : {}),
      ...(r.expiresAt ? { expiresAt: r.expiresAt } : r.durationHours > 0 ? { durationHours: r.durationHours } : { permanent: true as const }),
    });
    return postJson(`${API_BASE}/moderation/settings`, {
      roomId,
      ...(settings.linkPolicy ? { linkPolicy: settings.linkPolicy } : {}),
      ...(settings.bannedWords ? { bannedWords: settings.bannedWords } : {}),
      ...(settings.userRestrictions ? { userRestrictions: settings.userRestrictions.map(entry) } : {}),
    });
  },

  // Media Uploads (CH-089, D-32)
  async getMediaUploads(query?: { before?: string; limit?: number; flaggedOnly?: boolean }): Promise<MediaUpload[]> {
    try {
      const params = new URLSearchParams();
      if (query?.before) params.set('before', query.before);
      if (query?.limit) params.set('limit', String(query.limit));
      if (query?.flaggedOnly) params.set('flaggedOnly', 'true');
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await getJson(`${API_BASE}/media${qs}`);
      const payload = data?.data || data;
      return payload.uploads || [];
    } catch {
      return [];
    }
  },

  async flagMedia(uploadId: string, note: string) {
    return postJson(`${API_BASE}/media/flag`, { uploadId, note: note.trim() });
  },

  async deleteMedia(uploadId: string, note: string) {
    return postJson(`${API_BASE}/media/delete`, { uploadId, note: note.trim() });
  },

  // Regions (CH-084)
  async getRegions(): Promise<ChatRegion[]> {
    try {
      const data = await getJson(`${API_BASE}/regions`);
      const payload = data?.data || data;
      return payload.regions || [];
    } catch {
      return [];
    }
  },

  async createRegion(name: string, countries: string[]) {
    return postJson(`${API_BASE}/regions`, { name: name.trim(), countries });
  },

  async updateRegion(regionId: string, data: { name?: string; countries?: string[] }) {
    return postJson(`${API_BASE}/regions/update`, { regionId, ...data });
  },

  async deleteRegion(regionId: string) {
    return postJson(`${API_BASE}/regions/delete`, { regionId });
  },

  // Staff Roles (CH-017, D-21)
  async getStaffRoles(): Promise<ChatStaffRole[]> {
    try {
      const data = await getJson(`${API_BASE}/staff/roles`);
      const payload = data?.data || data;
      return payload.roles || [];
    } catch {
      return [];
    }
  },

  async assignStaffRole(userId: string, role: 'ADMIN' | 'MODERATOR' | 'SUPPORT', note: string) {
    return postJson(`${API_BASE}/staff/assign-role`, { userId, role, note: note.trim() });
  },

  async removeStaffRole(userId: string, note: string) {
    return postJson(`${API_BASE}/staff/remove-role`, { userId, note: note.trim() });
  },

  // Frequent Hitters (CH-088)
  async getFrequentHitters(limit = 50): Promise<FrequentHitter[]> {
    try {
      const data = await getJson(`${API_BASE}/hitters?limit=${limit}`);
      const payload = data?.data || data;
      return payload.hitters || [];
    } catch {
      return [];
    }
  },

  // Settings & Audit Rollback (CH-083, CH-084, NEW-2, NEW-3)
  async getSettings(): Promise<{ document: any; version: number; updatedAt: string }> {
    const data = await getJson(`${API_BASE}/settings`);
    return data?.data || data;
  },

  async previewSettings(country?: string): Promise<{ settings: any }> {
    const qs = country ? `?country=${encodeURIComponent(country)}` : '';
    const data = await getJson(`${API_BASE}/settings/preview${qs}`);
    return data?.data || data;
  },

  async saveSettings(patch: Record<string, unknown>, effectiveAt?: string) {
    return postJson(`${API_BASE}/settings`, {
      patch,
      ...(effectiveAt ? { effectiveAt } : {}),
    });
  },

  async getSettingsChanges(before?: string, limit = 50, status = 'ALL'): Promise<SettingsChange[]> {
    try {
      const params = new URLSearchParams({ limit: String(limit), status });
      if (before) params.set('before', before);
      const data = await getJson(`${API_BASE}/settings/changes?${params.toString()}`);
      const payload = data?.data || data;
      return payload.changes || [];
    } catch {
      return [];
    }
  },

  // Test-only stand-in facts (NEW-2): mark a user as on the casino, premium, KYC level, site owner for the demo.
  async getTestEntitlements(): Promise<any[]> {
    try {
      const data = await getJson(`${API_BASE}/test-entitlements`);
      return (data?.data || data)?.entitlements || [];
    } catch {
      return [];
    }
  },

  async upsertTestEntitlement(entry: Record<string, unknown>) {
    return postJson(`${API_BASE}/test-entitlements`, entry);
  },

  async deleteTestEntitlement(userId: string) {
    return postJson(`${API_BASE}/test-entitlements/delete`, { userId });
  },

  async rollbackSettings(changeId: string) {
    return postJson(`${API_BASE}/settings/rollback`, { changeId });
  },
};
