import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DM_ARCHIVE_AFTER_MONTHS, PARTITION_MONTHS_AHEAD, TIMERS } from './chat.constants';
import { DmMessagesDbOperation } from './dm/dm.messages.dboperation';
import { ChatBus } from './realtime/chat.bus';
import { ChatRecordsDbOperation } from './persistence/chat.records.dboperation';
import { ChatGateway } from './chat.gateway';
import { ChatModerationService } from './chat.moderation.service';
import { ChatPresenceService } from './chat.presence.service';
import { ChatService } from './chat.service';
import { ChatSettingsService } from './chat.settings';
import { removeUploadFile } from './chat.upload';
import { ChatAdsService } from './services/chat.ads.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Background maintenance worker: aggregates stats, syncs pinned ads, and manages message partitions. */
@Injectable()
export class ChatMaintenance implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ChatMaintenance');
  private timer: NodeJS.Timeout | null = null;
  private hitsTimer: NodeJS.Timeout | null = null;
  private flushingHits = false;
  private running = false;
  private lastPartitionCheck = 0;

  constructor(
    private readonly records: ChatRecordsDbOperation,
    private readonly dmMessages: DmMessagesDbOperation,
    private readonly settings: ChatSettingsService,
    private readonly presence: ChatPresenceService,
    private readonly moderation: ChatModerationService,
    private readonly chat: ChatService,
    private readonly gateway: ChatGateway,
    private readonly bus: ChatBus,
    private readonly ads: ChatAdsService,
  ) { }

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    void this.ensurePartitions();
    this.timer = setInterval(() => void this.tick(), TIMERS.TICK_MS);
    this.timer.unref();
    // Limit hits reach the admin's Frequent Hitters list within ~10 s.
    this.hitsTimer = setInterval(() => void this.flushHits(), 10_000);
    this.hitsTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.hitsTimer) clearInterval(this.hitsTimer);
  }

  private async flushHits(): Promise<void> {
    if (this.flushingHits) return;
    this.flushingHits = true;
    try {
      await this.step('limits', async () =>
        this.moderation.flushLimitHits(await this.settings.global()),
      );
    } finally {
      this.flushingHits = false;
    }
  }

  async ensurePartitions(): Promise<void> {
    this.lastPartitionCheck = Date.now();
    try {
      const { created, defaultRows } = await this.records.ensurePartitions(PARTITION_MONTHS_AHEAD);
      if (created > 0)
        this.logger.log({ component: 'ChatMaintenance', created }, 'created message partitions');
      const archived = await this.dmMessages.archiveOldMonths(DM_ARCHIVE_AFTER_MONTHS);
      if (archived > 0)
        this.logger.log({ component: 'ChatMaintenance', archived }, 'archived old DM months');
      if (defaultRows > 0) {
        this.logger.error(
          { component: 'ChatMaintenance', defaultRows },
          'messages landed in the DEFAULT partition: a month partition was missing when they were written',
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        { component: 'ChatMaintenance', err },
        'could not ensure message partitions',
      );
    }
  }

  private async step(name: string, run: () => Promise<void>): Promise<void> {
    const timeoutMs = 15_000;
    try {
      await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Maintenance step '${name}' timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } catch (err: unknown) {
      this.logger.error(
        { component: 'ChatMaintenance', err, step: name },
        'chat maintenance step failed',
      );
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const limitHits = this.moderation.hitsThisMinute();
      const messages = this.chat.takeSentCount();
      const stats = {
        onlineUsers: this.presence.onlineUsers(),
        sockets: this.presence.socketCount(),
        messagesLastMinute: messages,
      };

      await this.step('presence', () => this.presence.refreshMarkers());
      await this.step('stats', () => this.records.writeRuntimeStats(stats));
      await this.step('settings', async () => {
        const applied = await this.settings.applyDueChanges();
        if (applied.settings) this.bus.publish({ kind: 'settings' });
        for (const roomId of applied.roomIds) this.bus.publish({ kind: 'room', roomId });
      });
      await this.step('client_ids', async () => {
        await this.records.pruneClientIds(TIMERS.CLIENT_ID_RETENTION_HOURS);
        await this.dmMessages.pruneClientIds(TIMERS.CLIENT_ID_RETENTION_HOURS);
      });
      await this.step('media', async () => {
        for (const upload of await this.records.uploadsPendingRemoval()) {
          await removeUploadFile(upload.storageKey);
          await this.records.markUploadFileRemoved(upload.id);
        }
      });
      // Pinned slots are display: end and start them here. Everything that moves money runs in ChatMoneyLoop.
      await this.step('pins', () => this.ads.syncPins());
      if (Date.now() - this.lastPartitionCheck >= DAY_MS) await this.ensurePartitions();

      this.logger.log(
        {
          component: 'ChatMaintenance',
          ...stats,
          limitHits,
          refusals: this.gateway.takeRefusalCounts(),
        },
        'chat_stats',
      );
    } finally {
      this.running = false;
    }
  }
}
