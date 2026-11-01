import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '../../utils/public.utils';
import { ChatAccessService } from '../chat/chat.access.service';
import { ChatPorts } from '../chat/chat.ports';
import { ChatRestrictionsService } from '../chat/services/chat.restrictions.service';
import type { ChatUserContext, RoomRecord } from '../chat/chat.types';
import { effectiveStatus } from './rain.contract';
import { RainDbOperation } from './rain.dboperation';
import {
  applyFee,
  distribute,
  minorToUsd,
  percentToBps,
  userRecipientCount,
  type RecipientRule,
  type RainShare,
} from './rain.math';
import { RainPorts } from './rain.ports';
import type { RainRepeatRow, RainRunRow } from './rain.types';
import { RainPayoutService } from './rain.payout.service';
import { RainSelectionService } from './rain.selection.service';
import { RainWallet } from './rain.wallet';

export interface UserRainSeed {
  readonly id: string;
  readonly room: RoomRecord;
  readonly currency: string;
  readonly pot: bigint;
  readonly rule: RecipientRule;
  readonly repeatCount: number | null;
  readonly repeatGapSeconds: number | null;
}

@Injectable()
export class RainSeriesService {
  private readonly logger = new Logger('RainSeriesService');

  constructor(
    private readonly db: RainDbOperation,
    private readonly wallet: RainWallet,
    private readonly access: ChatAccessService,
    private readonly restrictions: ChatRestrictionsService,
    private readonly chatPorts: ChatPorts,
    private readonly rainPorts: RainPorts,
    private readonly selection: RainSelectionService,
    private readonly payout: RainPayoutService,
  ) {}

  async scheduleRepeatOf(userId: string, seed: UserRainSeed, paidTo: number): Promise<void> {
    if (seed.repeatCount === null || seed.repeatCount <= 1 || seed.repeatGapSeconds === null) return;
    await this.db.scheduleRepeat({
      id: uuidv7(),
      initiatorId: userId,
      roomId: seed.room.id,
      currency: seed.currency,
      potMinor: seed.pot,
      recipientCount: paidTo,
      recipientRule: seed.rule,
      remaining: seed.repeatCount - 1,
      gapSeconds: seed.repeatGapSeconds,
      nextRunAt: new Date(Date.now() + seed.repeatGapSeconds * 1000),
    });
  }

  // Runs one step of an auto-repeat series; pauses on OFF/MAINTENANCE without cancelling (V2-17)
  async runRepeat(repeat: RainRepeatRow): Promise<void> {
    const key = `repeat:${repeat.id}:${repeat.remaining}`;
    try {
      const cfg = await this.db.config();
      // On OFF or MAINTENANCE, pause series and reschedule for next slot (skipping missed runs)
      if (effectiveStatus(cfg, 'user') !== 'ON') {
        const nextDate = new Date(Date.now() + repeat.gapSeconds * 1000);
        await this.db.finishRepeat(repeat.id, repeat.remaining, nextDate);
        return;
      }
      const existing = await this.db.findByKey(key);
      if (existing) {
        await this.payout.afterPaid(existing);
      } else {
        const room = await this.access.requireRoom(repeat.roomId);
        await this.assertStillMayRain(repeat.initiatorId, room);
        const people = await this.selection.eligible(room, repeat.initiatorId);
        const rule: RecipientRule = repeat.recipientRule ?? { mode: 'SPECIFIC', count: repeat.recipientCount };
        const count = userRecipientCount(rule, people.length, cfg.user.recipients);
        if (typeof count === 'string') throw new Error(`${count}. The repeat series has stopped.`);
        const chosen = this.selection.shuffle(people).slice(0, count);
        const priced = applyFee(repeat.potMinor, percentToBps(cfg.user.feePercent));
        const shares = distribute(priced.distributable, chosen, cfg.user.allocation);
        if (shares.length !== chosen.length) {
          throw new Error('Amount is too small to split. The repeat series has stopped.');
        }
        const price = await this.rainPorts.usdPrice(repeat.currency);
        const run: RainRunRow & { shares: RainShare[] } = {
          id: uuidv7(),
          kind: 'USER',
          status: 'COMPLETED',
          roomId: repeat.roomId,
          initiatorId: repeat.initiatorId,
          currency: repeat.currency,
          potMinor: repeat.potMinor,
          feeMinor: priced.fee,
          distributableMinor: priced.distributable,
          idempotencyKey: key,
          messageId: null,
          requestedRecipients: count,
          recipientRule: rule,
          usdPriceMinor: price,
          usdValueMinor: price === null ? null : minorToUsd(repeat.potMinor, price),
          shares,
        };
        this.wallet.refuseIfUnavailable();
        await this.db.tx(async (tx) => {
          await this.wallet.ensurePayer(tx, repeat.initiatorId, repeat.currency);
          await this.wallet.apply(tx, this.payout.legsOf(run, repeat.initiatorId), repeat.currency);
          await this.db.insertRun(tx, run);
        });
        await this.audit('SYSTEM', repeat.initiatorId, 'REPEAT_PAID', run.id, null);
        await this.payout.afterPaid((await this.db.findByKey(key))!);
      }
      const left = repeat.remaining - 1;
      await this.db.finishRepeat(repeat.id, left, left > 0 ? new Date(Date.now() + repeat.gapSeconds * 1000) : null);
    } catch (err: unknown) {
      this.logger.warn({ repeatId: repeat.id, err }, 'rain repeat stopped');
      await this.db.failRepeat(repeat.id);
      await this.audit('SYSTEM', repeat.initiatorId, 'REPEAT_STOPPED', null, err instanceof Error ? err.message : 'failed');
    }
  }

  // Ensures the user retains raining permissions
  async assertStillMayRain(userId: string, room: RoomRecord): Promise<void> {
    const username = (await this.db.usernames([userId])).get(userId) ?? '';
    const person: ChatUserContext = { id: userId, username, publicCode: '', staffRole: null };
    const facts = await this.access.factsFor(person);
    if (await this.restrictions.find(person, facts, 'RESTRICT_RAIN', room, await this.db.dbNow())) {
      throw new Error('The user may no longer rain. The repeat series has stopped.');
    }
    const entitled = await this.chatPorts.rainEntitlements(userId);
    if (entitled && !entitled.canRain) throw new Error('The KYC level no longer allows raining. The repeat series has stopped.');
  }

  private async audit(
    actorType: 'ADMIN' | 'STAFF' | 'USER' | 'SYSTEM',
    actorId: string | null,
    action: string,
    rainId: string | null,
    reason: string | null,
  ): Promise<void> {
    try {
      await this.db.audit({ actorType, actorId, action, rainId, reason, detail: null });
    } catch (err: unknown) {
      this.logger.warn({ action, rainId, err }, 'could not write the rain audit log');
    }
  }
}

