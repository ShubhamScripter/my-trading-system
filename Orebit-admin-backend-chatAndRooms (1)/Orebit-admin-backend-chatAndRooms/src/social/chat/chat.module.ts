/**
 * The admin chat module: routes, controller, services, the database layer and the authority checks.
 * Imported by SocialModule.
 */
import { Module } from '@nestjs/common';
import { ChatModerationDbOperation } from './chat-moderation.dboperation';
import { ChatModerationService } from './services/chat-moderation.service';
import { ChatRegionDbOperation } from './persistence/chat-region.dboperation';
import { ChatRoomDbOperation } from './chat-room.dboperation';
import { ChatSettingsDbOperation } from './persistence/chat-settings.dboperation';
import { ChatSkinDbOperation } from './chat-skin.dboperation';
import { ChatSkinService } from './services/chat-skin.service';
import { ChatStaffDbOperation } from './persistence/chat-staff.dboperation';
import { ChatController } from './chat.controller';
import { ChatModerationSettingsService } from './services/chat.moderation-settings.service';
import { AuthModule } from '../../../auth/auth.module';
import { ChatRoutes } from './chat.routes';
import { ChatAuthorityService } from './services/chat-authority.service';
import { ChatService } from './chat.service';
import { ChatSettingsAdminService } from './services/chat.settings.service';
import { ChatModulesDbOperation } from './persistence/chat-modules.dboperation';
import { ChatModulesService } from './services/chat-modules.service';
import { ChatMoneyDbOperation } from './persistence/chat-money.dboperation';
import { ChatMoneyService } from './services/chat-money.service';
import { ChatStaffRequestsService } from './services/chat-staff-requests.service';
import { ChatModulesController, ChatModulesRoutes } from './chat.modules.routes';
import { ChatSupportDbOperation } from './persistence/chat-support.dboperation';
import { ChatSupportService } from './services/chat-support.service';
import { ChatSupportRoutes } from './chat.support.routes';
import { ChatReportStatsRoutes } from './chat-report-stats.routes';
import { ChatReportStatsDbOperation } from './persistence/chat-report-stats.dboperation';
import { RainAdminDbOperation } from '../rain/rain-admin.dboperation';
import { RainAdminRevertDbOperation } from '../rain/rain-admin.revert.dboperation';
import { RainAdminRoutes } from '../rain/rain-admin.routes';
import { RainAdminService } from '../rain/rain-admin.service';
import { RainAdminReviewService } from '../rain/rain-admin.review.service';
import { RainAdminRevertService } from '../rain/rain-admin.revert.service';

@Module({
  // AuthModule exports AdminDbOperation, which SuperAdminGuard and ChatAuthorityService read the role through.
  imports: [AuthModule],
  controllers: [ChatRoutes, ChatModulesRoutes, ChatSupportRoutes, ChatReportStatsRoutes, RainAdminRoutes],
  providers: [
    ChatReportStatsDbOperation,
    ChatAuthorityService,
    ChatController,
    ChatService,
    ChatModerationService,
    ChatSkinService,
    ChatSettingsAdminService,
    ChatModerationSettingsService,
    ChatRoomDbOperation,
    ChatRegionDbOperation,
    ChatModerationDbOperation,
    ChatSkinDbOperation,
    ChatStaffDbOperation,
    ChatSettingsDbOperation,
    // Modules 4–9
    ChatModulesDbOperation,
    ChatModulesService,
    ChatMoneyDbOperation,
    ChatMoneyService,
    ChatStaffRequestsService,
    ChatModulesController,
    ChatSupportDbOperation,
    ChatSupportService,
    // RainPool
    RainAdminRevertDbOperation,
    RainAdminDbOperation,
    RainAdminReviewService,
    RainAdminRevertService,
    RainAdminService,
  ],
  exports: [ChatService, ChatModerationService, ChatSettingsAdminService],
})
export class ChatModule {}
