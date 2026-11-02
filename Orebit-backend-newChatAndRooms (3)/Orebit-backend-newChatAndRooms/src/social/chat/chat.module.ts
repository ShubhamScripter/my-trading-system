import { Module } from '@nestjs/common';
import { AuthModule } from '../../../auth/auth.module';
import { TwoFactorModule } from '../../2fa/2fa.module';
import { ChatAccessService } from './chat.access.service';
import { ChatAccountService } from './services/chat.account.service';
import { ChatAuthHelper } from './chat.auth.helper';
import { ChatBus } from './realtime/chat.bus';
import { ChatDelivery } from './realtime/chat.delivery';
import { ChatController } from './chat.controller';
import { ChatRoutes } from './chat.routes';
import { ChatDbOperation } from './chat.dboperation';
import { ChatHistoryDbOperation } from './persistence/chat.history.dboperation';
import { ChatEventsListener } from './chat.events.listener';
import { ChatGateway } from './chat.gateway';
import { ChatMaintenance } from './chat.maintenance';
import { ChatContentService } from './services/chat.content.service';
import { ChatModerationService } from './chat.moderation.service';
import { ChatPorts, RegistrationCountryProvider } from './chat.ports';
import { TestProviders } from './chat.test-providers';
import { ChatPresenceService } from './chat.presence.service';
import { ChatRecordsDbOperation } from './persistence/chat.records.dboperation';
import { ChatReportService, ChatStaffService } from './services/chat.staff.service';
import { ChatReadService } from './services/chat.read.service';
import { ChatLimitationsService } from './services/chat.limitations.service';
import { ChatLimitationsDbOperation } from './persistence/chat.limitations.dboperation';
import { ChatService } from './chat.service';
import { ChatSessionAdapter } from './chat.session.adapter';
import { ChatSessionWatch } from './realtime/chat.session.watch';
import { ChatSettingsService } from './chat.settings';
import { ChatSettingsDbOperation } from './persistence/chat.settings.dboperation';
// Module 4: role permissions and staff tools.
import { ChatStaffDbOperation } from './persistence/chat.staff.dboperation';
import { ChatStaffQueueDbOperation } from './persistence/chat.staff-queue.dboperation';
import { ChatRestrictionsService } from './services/chat.restrictions.service';
import { ChatStaffGate } from './services/chat.staff.gate';
import { ChatStaffToolsService } from './services/chat.staff.tools.service';
import { ChatStaffPenaltiesService } from './services/chat.staff.penalties.service';
import { ChatStaffGroupService } from './services/chat.staff.group.service';
import { ChatStaffQueueService } from './services/chat.staff.queue.service';
import { ChatStaffRequestsService } from './services/chat.staff.requests.service';
import { ChatStaffInsightService } from './services/chat.staff.insight.service';
import { ChatStaffController } from './chat.staff.controller';
import { ChatStaffRoutes } from './chat.staff.routes';
// Module 5: commands, mute and block, ads, gifts.
import { ChatFeaturePorts } from './chat.feature-ports';
import { ChatMuteBlockDbOperation } from './persistence/chat.mute-block.dboperation';
import { ChatAdDbOperation } from './persistence/chat.ad.dboperation';
import { ChatAdPinsDbOperation } from './persistence/chat.ad-pins.dboperation';
import { ChatMoneyLoop } from './chat.money-loop';
import { ChatAdsPaymentService } from './services/chat.ads.payment';
import { ChatAdsPlanner } from './services/chat.ads.plan';
import { ChatGiftsSettlementService } from './services/chat.gifts.settlement';
import { ChatGiftDbOperation } from './persistence/chat.gift.dboperation';
import { ChatRelationsService } from './services/chat.relations.service';
import { ChatAdsService } from './services/chat.ads.service';
import { ChatAdsSettlementService } from './services/chat.ads.settlement';
import { ChatAdsReadService } from './services/chat.ads.read';
import { ChatGiftsService } from './services/chat.gifts.service';
import { ChatCommandsService } from './services/chat.commands.service';
import { ChatSocialController } from './chat.social.controller';
import { ChatSocialRoutes } from './chat.social.routes';
// Modules 8–9: direct messages and groups.
import { DmDbOperation } from './dm/dm.dboperation';
import { DmMessagesDbOperation } from './dm/dm.messages.dboperation';
import { DmInboxDbOperation } from './dm/dm.inbox.dboperation';
import { DmGroupsDbOperation } from './dm/dm.groups.dboperation';
import { DmGroupInvitesDbOperation } from './dm/dm.group-invites.dboperation';
import { DmGroupBansDbOperation } from './dm/dm.group-bans.dboperation';
import { DmService } from './dm/dm.service';
import { DmActionsService } from './dm/dm.actions.service';
import { ChatActionLimiter } from './platform/limiter';
import { ChatActionGate } from './services/chat.action-gate.service';
import { DmCardsService } from './dm/dm.cards.service';
import { DmPrivacyService } from './dm/dm.privacy.service';
import { DmGroupInvitesService } from './dm/dm.groups.invites.service';
import { DmDeliveryService } from './dm/dm.delivery.service';
import { DmSignalsService } from './dm/dm.signals.service';
import { DmInboxService } from './dm/dm.inbox.service';
import { DmGroupsService } from './dm/dm.groups.service';
import { DmGroupsModerationService } from './dm/dm.groups.moderation.service';
import { DmController } from './dm/dm.controller';
import { DmRoutes } from './dm/dm.routes';
import { DmGateway } from './dm/dm.gateway';
import { ChatSupportDbOperation } from './persistence/chat.support.dboperation';
import { ChatSupportService } from './support/support.service';
import { SupportController } from './support/support.controller';
import { SupportRoutes } from './support/support.routes';
import { RainAdminService } from '../rain/rain.admin.service';
import { RainDbOperation } from '../rain/rain.dboperation';
import { RainJobsDbOperation } from '../rain/rain.jobs.dboperation';
import { RainHistoryDbOperation } from '../rain/rain.history.dboperation';
import { RainRevertDbOperation } from '../rain/rain.revert.dboperation';
import { RainSelectionService } from '../rain/rain.selection.service';
import { RainPayoutService } from '../rain/rain.payout.service';
import { RainSeriesService } from '../rain/rain.series.service';
import { RainSchedulerService } from '../rain/rain.scheduler.service';
import { RainRevertService } from '../rain/rain.revert.service';
import { RainRoutes } from '../rain/rain.routes';
import { RainScheduler } from '../rain/rain.scheduler';
import { RainService } from '../rain/rain.service';
import { RainWallet } from '../rain/rain.wallet';
import { RainPorts } from '../rain/rain.ports';
import { ChatMoneyRevertDbOperation } from './persistence/chat.money-revert.dboperation';
import { ChatMoneyRevertService } from './services/chat.money-revert.service';

// The chat module (Modules 1–9 of the chat roadmap). See README.md in this folder.
// AuthModule is imported for `SessionService` (whether a session is still live); chat never edits auth code.
// TwoFactorModule provides the payment-PIN and transfer-confirmation capability through chat.feature-ports.ts.
// Facts owned by other modules come through the ports in chat.ports.ts: a module binds its provider here, e.g.
// `{ provide: CHAT_PREMIUM_PORT, useExisting: PremiumChatProvider }`, and nothing else in chat changes.
@Module({
  imports: [AuthModule, TwoFactorModule],
  controllers: [ChatRoutes, ChatStaffRoutes, ChatSocialRoutes, DmRoutes, SupportRoutes, RainRoutes],
  providers: [
    ChatController,
    ChatBus,
    ChatDbOperation,
    ChatHistoryDbOperation,
    ChatRecordsDbOperation,
    ChatSettingsDbOperation,
    ChatSettingsService,
    RegistrationCountryProvider,
    ChatPorts,
    TestProviders,
    ChatAccessService,
    ChatModerationService,
    ChatContentService,
    ChatStaffService,
    ChatReportService,
    ChatPresenceService,
    ChatAccountService,
    ChatService,
    ChatReadService,
    ChatLimitationsService,
    ChatLimitationsDbOperation,
    ChatSessionAdapter,
    ChatAuthHelper,
    ChatDelivery,
    ChatGateway,
    ChatSessionWatch,
    ChatEventsListener,
    ChatMaintenance,
    // Module 4
    ChatStaffDbOperation,
    ChatStaffQueueDbOperation,
    ChatRestrictionsService,
    ChatStaffGate,
    ChatStaffToolsService,
    ChatStaffPenaltiesService,
    ChatStaffQueueService,
    ChatStaffGroupService,
    ChatStaffRequestsService,
    ChatStaffInsightService,
    ChatStaffController,
    // Module 5
    ChatFeaturePorts,
    ChatMuteBlockDbOperation,
    ChatAdDbOperation,
    ChatAdPinsDbOperation,
    ChatAdsPlanner,
    ChatAdsPaymentService,
    ChatGiftsSettlementService,
    ChatMoneyLoop,
    ChatGiftDbOperation,
    ChatRelationsService,
    ChatActionLimiter,
    ChatActionGate,
    ChatAdsService,
    ChatAdsSettlementService,
    ChatAdsReadService,
    ChatGiftsService,
    ChatMoneyRevertDbOperation,
    ChatMoneyRevertService,
    ChatCommandsService,
    ChatSocialController,
    // Modules 8–9
    DmDbOperation,
    DmMessagesDbOperation,
    DmInboxDbOperation,
    DmGroupsDbOperation,
    DmGroupInvitesDbOperation,
    DmGroupBansDbOperation,
    DmService,
    DmActionsService,
    DmCardsService,
    DmPrivacyService,
    DmGroupInvitesService,
    DmDeliveryService,
    DmSignalsService,
    DmInboxService,
    DmGroupsService,
    DmGroupsModerationService,
    DmController,
    DmGateway,
    ChatSupportDbOperation,
    ChatSupportService,
    SupportController,
    RainJobsDbOperation,
    RainHistoryDbOperation,
    RainRevertDbOperation,
    RainDbOperation,
    RainSelectionService,
    RainPayoutService,
    RainSeriesService,
    RainRevertService,
    RainSchedulerService,
    RainWallet,
    RainPorts,
    RainService,
    RainScheduler,
    RainAdminService,
  ],
  exports: [ChatService, ChatDelivery],
})
export class ChatModule {}
