import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { TIMERS } from './chat.constants';
import { ChatSettingsService } from './chat.settings';
import { ChatBus } from './realtime/chat.bus';
import { ChatAdsService } from './services/chat.ads.service';
import { ChatGiftsSettlementService } from './services/chat.gifts.settlement';
import { moneyJobConfig, missingMoneyNumbers } from './services/chat.money-config';
import { ChatMoneyRevertService } from './services/chat.money-revert.service';

/** Asynchronous worker loop processing ad payments, scheduled repeats, and financial reverts. */
@Injectable()
export class ChatMoneyLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ChatMoneyLoop');
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private again = false;
  private lastMissingLog = 0;

  constructor(
    private readonly settings: ChatSettingsService,
    private readonly ads: ChatAdsService,
    private readonly gifts: ChatGiftsSettlementService,
    private readonly moneyReverts: ChatMoneyRevertService,
    private readonly bus: ChatBus,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    // An admin created, cancelled or reverted an ad, or an advertiser cancelled one: do its money now, not next tick.
    this.unsubscribe = this.bus.subscribe((change) => {
      if (change.kind === 'ad') {
        void this.ads.announceCancelledPins(change.adId).catch((err: unknown) =>
          this.logger.warn({ component: 'ChatMoneyLoop', err, adId: change.adId }, 'cancelled pin notification failed'),
        );
        void this.kick();
      }
    });
    this.timer = setInterval(() => void this.kick(), TIMERS.MONEY_LOOP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }

  /** Runs a pass now, or marks that one more must follow the pass that is running. */
  async kick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        try {
          await this.pass();
        } catch (err: unknown) {
          this.logger.error({ component: 'ChatMoneyLoop', err }, 'money loop pass failed');
        }
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  /** One pass of every money step. A step that fails is logged and does not stop the others. */
  async pass(): Promise<void> {
    const settings = await this.settings.global();
    const config = moneyJobConfig(settings);
    if (!config) {
      if (Date.now() - this.lastMissingLog >= 10 * 60_000) {
        this.lastMissingLog = Date.now();
        this.logger.warn(
          { component: 'ChatMoneyLoop', missing: missingMoneyNumbers(settings) },
          'money jobs are not running: the admin has not set these numbers',
        );
      }
      return;
    }
    if (config.giftProcessingMinutes === null && Date.now() - this.lastMissingLog >= 10 * 60_000) {
      this.lastMissingLog = Date.now();
      this.logger.warn(
        { component: 'ChatMoneyLoop', missing: missingMoneyNumbers(settings) },
        'gift reconciliation is not running: the admin has not set gifts.processingStaleMinutes',
      );
    }
    const steps: [string, (until: number) => Promise<void>][] = [
      ['money_reverts', (until) => this.moneyReverts.process(config, until)],
      ['ads', (until) => this.ads.moneyPass(config, until)],
      ['gifts', (until) => this.gifts.run(config, until)],
    ];
    const share = config.budgetMs / steps.length;
    for (const [name, run] of steps) {
      try {
        await run(Date.now() + share);
      } catch (err: unknown) {
        this.logger.error({ component: 'ChatMoneyLoop', err, step: name }, 'money loop step failed');
      }
      if (name === 'ads') await this.ads.syncPins();
    }
  }
}
