/**
 * RainPool admin API (Orebit-admin-backend src/social/rain/rain-admin.routes.ts, under /social/rain). Reads throw on
 * failure; writes answer `{ success, error?, errors?, ...data }` like the rest of AdminAPI. Money only moves on the
 * chat server's next rain tick (about 15 seconds), so trigger / approve / reject / revert answer `queued` and the
 * job list shows the outcome. The settings document is rain contract v4 (src/social/rain/rain.contract.ts).
 */
import { API_BASE, postJson } from './api';

const BASE = API_BASE.replace(/\/social\/chat$/, '/social/rain');

export type RainStatus = 'ON' | 'OFF' | 'MAINTENANCE';
export type Trigger = 'OFF' | 'AUTO' | 'MANUAL';
export type RecipientMode = 'SPECIFIC' | 'ALL' | 'PERCENT';
export type DurationUnit = 'SECONDS' | 'MINUTES' | 'HOURS';
export interface Duration {
  value: number;
  unit: DurationUnit;
}
export interface Allocation {
  normalPercent: number;
  plans: { planId: string; percent: number }[];
}
export interface RewardRule {
  mode: 'FIXED' | 'DYNAMIC';
  amount: number;
  everyUsd: string;
}
export interface AmountLimit {
  /** USD = "Same for all Currencies"; PER_CURRENCY = "Set Separately for Each Currency". */
  mode: 'USD' | 'PER_CURRENCY';
  usd: string;
  perCurrency: { code: string; amount: string }[];
}
export interface RainQuestion {
  text: string;
  options: string[];
  /** Indexes of the options that count as OK. */
  okOptions: number[];
}

export interface RainConfig {
  status: { overall: RainStatus; system: RainStatus; user: RainStatus; note: string | null };
  system: {
    currencies: string[];
    amountUsd: { min: string; max: string };
    interval: { min: Duration; max: Duration };
    recipients: { mode: RecipientMode; count: number; percent: number };
    threshold: number | null;
    allocation: Allocation;
    roomId: string | null;
  };
  user: {
    currencies: { all: boolean; codes: string[] };
    minAmount: AmountLimit;
    maxAmount: AmountLimit;
    recipients: { modes: RecipientMode[]; min: number; max: number };
    allocation: Allocation;
    channels: { all: boolean; roomIds: string[] };
    feePercent: number;
    autoRepeat: { enabled: boolean; minCount: number; maxCount: number; minGap: Duration; maxGap: Duration };
  };
  rewards: {
    perRainDone: { exp: RewardRule; stars: RewardRule };
    perRainReceived: { exp: RewardRule; stars: RewardRule };
  };
  security: {
    commonIp: { enabled: boolean };
    newIpSameCountry: { enabled: boolean; amountAboveUsd: string | null; require: 'ONE' | 'BOTH' };
    newCountry: { enabled: boolean; amountAboveUsd: string | null; questionnaire: boolean; kycCheck: boolean };
    vpnProxy: { enabled: boolean; amountAboveUsd: string | null; questionnaire: Trigger; kycCheck: Trigger };
    questions: RainQuestion[];
    kycMinLevel: number;
  };
}

export interface RainSettings {
  contractVersion: number;
  version: number;
  updatedAt: string;
  /** Null when the stored document does not parse; `stored` and `problems` then say why. */
  config: RainConfig | null;
  stored?: unknown;
  problems: string[];
  defaults: RainConfig;
}

export interface RainState {
  status: RainConfig['status'] & { effective: { system: RainStatus; user: RainStatus } };
  next: { at: string | null; scheduledAt: string | null; currency: string | null; pot: string | null; potUsd: string | null };
  pendingReview: number;
  waitingForUser: number;
  openJobs: number;
  activeRepeats: number;
}

export interface RainRun {
  id: string;
  kind: 'SYSTEM' | 'USER';
  status: string;
  roomId: string;
  roomName: string | null;
  userId: string | null;
  username: string | null;
  currency: string;
  pot: string;
  fee: string;
  distributed: string;
  usd: string | null;
  recipients: number;
  recipientRule: { mode: RecipientMode; count?: number; percent?: number } | null;
  repeat: { count: number; gapSeconds: number | null } | null;
  reverseReason: string | null;
  reversedAt: string | null;
  verifyExpiresAt: string | null;
  createdAt: string;
  security?: { tier?: number; stage?: string; reasons?: string[]; manual?: boolean; verifiedAt?: string | null; questions?: RainQuestion[]; kycLevel?: number | null } | null;
}

export interface RainJob {
  id: string;
  kind: string;
  rainId: string | null;
  adminId: string | null;
  reason: string | null;
  status: string;
  error: string | null;
  payerRefund: 'REFUND' | 'NONE';
  shortfall: 'ZERO' | 'NEGATIVE';
  filter: unknown;
  progress: { matched?: number; reverted?: number; skipped?: number; failed?: number } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RainAudit {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  rainId: string | null;
  reason: string | null;
  detail: unknown;
  createdAt: string;
}

export interface RainDetail {
  rain: RainRun & { rewards: unknown; reverseDetail: unknown };
  recipients: { userId: string; username: string | null; amount: string; tier: string; reversedAt: string | null; reclaimed: string | null }[];
  audit: RainAudit[];
  jobs: RainJob[];
}

export interface RainRepeat {
  id: string;
  userId: string;
  username: string | null;
  roomId: string;
  currency: string;
  pot: string;
  recipients: { mode: RecipientMode; count?: number; percent?: number };
  remaining: number;
  gapSeconds: number;
  nextRunAt: string;
  status: string;
  createdAt: string;
}

export interface ScheduledChange {
  id: string;
  applyAt: string;
  patch: Partial<RainConfig['status']>;
  state: string;
  createdBy: string | null;
  createdAt: string;
  appliedAt: string | null;
  error: string | null;
}

export interface RainFilter {
  kind?: 'SYSTEM' | 'USER';
  status?: string;
  currency?: string;
  /** A user id, username or public code: the rainer or a recipient. */
  user?: string;
  from?: string;
  to?: string;
}

/** "Revert Specific Rains" choices. */
export interface RevertPolicy {
  /** User rains: REFUND gives what is taken back to the payer (never the fee); NONE = do nothing. */
  payerRefund: 'REFUND' | 'NONE';
  /** Recipients without the funds: ZERO = refund till 0; NEGATIVE = negative balance. */
  shortfall: 'ZERO' | 'NEGATIVE';
}

export interface BulkRevertInput extends RevertPolicy {
  kind: 'ALL' | 'SYSTEM' | 'USER';
  from: string | null;
  to: string | null;
  currencies: string[];
  who: { role: 'RAINER' | 'RECIPIENT'; users: string[]; group: { targetType: 'PREMIUM' | 'KYC' | 'LEVEL'; value: string } | null } | null;
  reason?: string;
  dryRun: boolean;
}

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const res = await fetch(`${BASE}${path}${q.toString() ? `?${q}` : ''}`, { credentials: 'include' });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.errors?.[0]?.message || json?.detail || json?.title || `Request failed (${res.status})`);
  return (json?.data ?? json) as T;
}

/** The first field error, as "path: message", else the detail. */
export function writeError(res: { error?: string; errors?: { path: string; message: string }[] }): string {
  const field = res.errors?.[0];
  return field ? `${field.path}: ${field.message}` : res.error || 'Request failed';
}

export const RainAPI = {
  settings: () => get<RainSettings>('/settings'),
  saveSettings: (config: RainConfig, expectedVersion: number) => postJson(`${BASE}/settings`, { config, expectedVersion }),
  state: () => get<RainState>('/state'),
  setStatus: (patch: Partial<RainConfig['status']>) => postJson(`${BASE}/status`, patch),
  scheduled: () => get<{ changes: ScheduledChange[] }>('/status/scheduled', { limit: 50 }),
  schedule: (applyAt: string, patch: Partial<RainConfig['status']>) => postJson(`${BASE}/status/schedule`, { applyAt, patch }),
  cancelSchedule: (id: string) => postJson(`${BASE}/status/schedule/cancel`, { id }),
  rains: (filter: RainFilter, limit = 100) => get<{ rains: RainRun[]; next: string | null }>('/rains', { ...filter, limit }),
  detail: (rainId: string) => get<RainDetail>('/rains/detail', { rainId }),
  reviews: () => get<{ pendingReview: RainRun[]; waitingForUser: RainRun[] }>('/reviews'),
  approve: (rainId: string, reason?: string) => postJson(`${BASE}/reviews/approve`, { rainId, ...(reason ? { reason } : {}) }),
  reject: (rainId: string, reason?: string) => postJson(`${BASE}/reviews/reject`, { rainId, ...(reason ? { reason } : {}) }),
  /** "Questionnaire: Manual Trigger" / "Request KYC Check: Manual": sends the rain back to its payer. */
  requestVerification: (rainId: string, questionnaire: boolean, kyc: boolean, reason?: string) =>
    postJson(`${BASE}/reviews/request`, { rainId, questionnaire, kyc, ...(reason ? { reason } : {}) }),
  revert: (rainId: string, reason: string, policy: RevertPolicy) => postJson(`${BASE}/revert`, { rainId, reason, ...policy }),
  bulkRevert: (input: BulkRevertInput) => postJson(`${BASE}/revert/bulk`, input),
  trigger: () => postJson(`${BASE}/trigger`, {}),
  jobs: () => get<{ jobs: RainJob[] }>('/jobs', { limit: 100 }),
  repeats: (status?: string, user?: string) => get<{ repeats: RainRepeat[] }>('/repeats', { status, user, limit: 100 }),
  cancelRepeat: (repeatId: string, reason?: string) => postJson(`${BASE}/repeats/cancel`, { repeatId, ...(reason ? { reason } : {}) }),
  audit: () => get<{ entries: RainAudit[]; next: string | null }>('/audit', { limit: 100 }),
  devPrices: () => get<{ development: boolean; prices: { currency: string; usdPrice: string; updatedAt: string }[] }>('/dev-prices'),
  setDevPrices: (prices: { currency: string; usdPrice: string | null }[]) => postJson(`${BASE}/dev-prices`, { prices }),
};
