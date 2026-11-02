// The admin's numbers for the money work: none has a built-in value. An unset one is `null`, and while any of
// the four ads numbers is unset an ad cannot be bought (the work they limit would never run) and the money loop only
// says what is missing. Gifts have their own number, used only to reconcile gifts stuck PROCESSING.
import type { ChatSettings } from '../chat.settings.contract';

export interface MoneyJobConfig {
  // Rows one step takes at a time.
  readonly pageSize: number;
  // How long one pass of the money loop may run.
  readonly budgetMs: number;
  // A claim older than this is a dead worker's and is taken over.
  readonly staleSeconds: number;
  // An ad left PENDING_PAYMENT longer than this is reconciled with the Charge port.
  readonly pendingPaymentMinutes: number;
  // A gift left PROCESSING longer than this is reconciled with the Transfer port; null = not set, only logged.
  readonly giftProcessingMinutes: number | null;
}

// The settings names that are still null, for the refusal and the log.
export function missingMoneyNumbers(settings: ChatSettings): string[] {
  const ads = settings.ads;
  return (
    [
      ['ads.pendingPaymentMinutes', ads.pendingPaymentMinutes],
      ['ads.jobStaleMinutes', ads.jobStaleMinutes],
      ['ads.jobPageSize', ads.jobPageSize],
      ['ads.jobBudgetSeconds', ads.jobBudgetSeconds],
      ['gifts.processingStaleMinutes', settings.gifts.processingStaleMinutes],
    ] as const
  )
    .filter(([, value]) => value === null)
    .map(([name]) => name);
}

// The numbers as the steps use them, or null while any is unset.
export function moneyJobConfig(settings: ChatSettings): MoneyJobConfig | null {
  const { pendingPaymentMinutes, jobStaleMinutes, jobPageSize, jobBudgetSeconds } = settings.ads;
  if (pendingPaymentMinutes === null || jobStaleMinutes === null || jobPageSize === null || jobBudgetSeconds === null) {
    return null;
  }
  return {
    pageSize: jobPageSize,
    budgetMs: jobBudgetSeconds * 1000,
    staleSeconds: jobStaleMinutes * 60,
    pendingPaymentMinutes,
    giftProcessingMinutes: settings.gifts.processingStaleMinutes,
  };
}
