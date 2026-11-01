import { apiFetch } from "./client";

/**
 * RainPool (Modules 6–7): GET/POST /social/rain/* on the user backend. Amounts are decimal strings in crypto units;
 * USD values are decimal strings too. The settings themselves are the admin panel's.
 */

export type RainSwitch = "ON" | "OFF" | "MAINTENANCE";
export type RecipientMode = "SPECIFIC" | "ALL" | "PERCENT";

export interface RainRewardRule {
  mode: "FIXED" | "DYNAMIC";
  amount: number;
  everyUsd: string;
}

export interface RainAmountLimit {
  mode: "USD" | "PER_CURRENCY";
  usd: string;
  perCurrency: { code: string; amount: string }[];
}

export interface RainState {
  /** "ON / OFF / MAINTAIN": what each side is now (after "Disable Overall Rains") and the maintenance text. */
  status: { overall: RainSwitch; system: RainSwitch; user: RainSwitch; note: string | null };
  system: {
    status: RainSwitch;
    nextRainAt: string | null;
    /** When the countdown started: the pot counts up from here to `nextRainAt`. */
    scheduledAt: string | null;
    /** The currency and pot already chosen for the next rain. */
    nextCurrency: string | null;
    nextPot: string | null;
    nextPotUsd: string | null;
    currencies: string[];
    amountUsd: { min: string; max: string };
    roomId: string;
  };
  user: {
    status: RainSwitch;
    feePercent: number;
    currencies: { all: boolean; codes: string[] };
    minAmount: RainAmountLimit;
    maxAmount: RainAmountLimit;
    recipients: { modes: RecipientMode[]; min: number; max: number };
    channels: { all: boolean; roomIds: string[] };
    autoRepeat: { enabled: boolean; minCount: number; maxCount: number; minGapSeconds: number; maxGapSeconds: number };
    command: string;
  };
  rewards: {
    perRainDone: { exp: RainRewardRule; stars: RainRewardRule };
    perRainReceived: { exp: RainRewardRule; stars: RainRewardRule };
  };
  walletConnected: boolean;
  pricesConnected: boolean;
  last: { id: string; kind: string; status: string; currency: string; pot: string; createdAt: string } | null;
}

/** The limits of one currency right now, in that currency. */
export interface RainLimits {
  currency: string;
  allowed: boolean;
  usdPrice: string | null;
  min: string | null;
  max: string | null;
  problem: string | null;
  feePercent: number;
  recipients: { modes: RecipientMode[]; min: number; max: number };
}

export interface RainHistoryItem {
  id: string;
  kind: "SYSTEM" | "USER";
  status: string;
  roomId: string;
  initiator: string | null;
  currency: string;
  pot: string;
  usd: string | null;
  recipients: number;
  createdAt: string;
}

export interface MyRains {
  sent: { id: string; status: string; roomId: string; currency: string; pot: string; fee: string; usd: string | null; recipients: number; createdAt: string }[];
  received: { rainId: string; kind: string; status: string; currency: string; amount: string; reversed: boolean; from: string | null; createdAt: string }[];
  repeats: { id: string; currency: string; pot: string; remaining: number; gapSeconds: number; nextRunAt: string }[];
  balances: { currency: string; balance: string }[];
}

/** What /rain or a confirmation answered. `verification` is present while it waits for codes / answers. */
export interface RainResult {
  rainId: string;
  status: "PENDING_VERIFICATION" | "PENDING_REVIEW" | "COMPLETED" | string;
  currency: string;
  pot: string;
  fee: string;
  usd: string | null;
  recipients: number;
  messageId: string | null;
  verification?: {
    tier: number;
    /** INITIAL: asked with the command. ADMIN_REQUEST: an admin reviewing the rain asked for it. */
    stage: "INITIAL" | "ADMIN_REQUEST";
    twoFa: boolean;
    email: boolean;
    /** ONE: either code is enough. BOTH: both. */
    require: "ONE" | "BOTH";
    questions: { text: string; options: string[] }[];
    /** The KYC level owed, or null. */
    kycLevel: number | null;
    /** An admin approves the rain after this. */
    manual: boolean;
    reasons: string[];
    expiresAt: string;
  };
}

/** How far the next Rainpool pot has filled: 0 at scheduling, the whole pot at rain time. */
export function rainCountUp(system: { nextPot: string | null; scheduledAt: string | null; nextRainAt: string | null }, now: number): string | null {
  if (!system.nextPot || !system.nextRainAt) return null;
  const end = new Date(system.nextRainAt).getTime();
  const start = system.scheduledAt ? new Date(system.scheduledAt).getTime() : end;
  const progress = end <= start ? 1 : Math.min(1, Math.max(0, (now - start) / (end - start)));
  const value = Number(system.nextPot) * progress;
  return value.toFixed(8).replace(/\.?0+$/, "") || "0";
}

/** "Fixed 5" or "2 per 10$". */
export function rewardText(rule: RainRewardRule): string {
  if (rule.amount === 0) return "0";
  return rule.mode === "FIXED" ? String(rule.amount) : `${rule.amount} per ${rule.everyUsd}$`;
}

const data = <T,>(res: { data: T }) => res.data;

export const getRainState = () =>
  apiFetch<{ data: RainState }>("/social/rain/state", { fallbackMessage: "Could not load RainPool" }).then(data);

export const getRainLimits = (currency: string) =>
  apiFetch<{ data: RainLimits }>(`/social/rain/limits?currency=${encodeURIComponent(currency)}`, {
    fallbackMessage: "Could not load the rain limits",
  }).then(data);

export const getRainHistory = (limit = 30) =>
  apiFetch<{ data: RainHistoryItem[] }>(`/social/rain/history?limit=${limit}`, { fallbackMessage: "Could not load rain history" }).then(data);

export const getMyRains = (limit = 30) =>
  apiFetch<{ data: MyRains }>(`/social/rain/mine?limit=${limit}`, { fallbackMessage: "Could not load your rains" }).then(data);

export interface RainBalances {
  walletConnected: boolean;
  /** True while the development wallet stands in for the real one. */
  development: boolean;
  balances: { currency: string; balance: string }[];
}

export const getRainBalances = () =>
  apiFetch<{ data: RainBalances }>("/social/rain/balances", { fallbackMessage: "Could not load your balance" }).then(data);

/** My rains waiting for me (codes, questionnaire, KYC — including what an admin asked for). */
export const getPendingRains = () =>
  apiFetch<{ data: RainResult[] }>("/social/rain/pending", { fallbackMessage: "Could not load your pending rains" }).then(data);

/** `answers`: the chosen option of each questionnaire question, in order. */
export const confirmRain = (input: { rainId: string; totpCode?: string; emailCode?: string; answers?: number[] }) =>
  apiFetch<{ data: RainResult }>("/social/rain/confirm", {
    method: "POST",
    body: input,
    fallbackMessage: "Could not confirm the rain",
  }).then(data);

export const resendRainCode = (rainId: string) =>
  apiFetch<{ data: { sent: true } }>("/social/rain/resend-code", {
    method: "POST",
    body: { rainId },
    fallbackMessage: "Could not send a new code",
  }).then(data);

export const cancelRain = (rainId: string) =>
  apiFetch<{ data: { cancelled: true } }>("/social/rain/cancel", {
    method: "POST",
    body: { rainId },
    fallbackMessage: "Could not cancel the rain",
  }).then(data);

/** Stops the rest of one of my auto-repeat series. */
export const cancelRepeat = (repeatId: string) =>
  apiFetch<{ data: { cancelled: true } }>("/social/rain/repeats/cancel", {
    method: "POST",
    body: { repeatId },
    fallbackMessage: "Could not stop the repeat",
  }).then(data);
