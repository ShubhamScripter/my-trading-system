import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [ChatModule],
  exports: [ChatModule],
})
export class SocialModule {}
