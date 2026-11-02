import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { LIMITS, PAGE } from '../chat.constants';

// Inputs of personal chat (Modules 8–9), for both transports. Validated by `WsValidationPipe`, which refuses unknown
// fields, like every chat input.

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IsUuidLike = (): PropertyDecorator =>
  Matches(UUID_SHAPE, { message: '$property must be a UUID' });
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class Page {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGE.MAX)
  limit?: number;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;
}

// A message body: text, or media with an optional caption.
class MessageBody {
  @Transform(trim)
  @ValidateIf((dto: MessageBody) => dto.mediaUrl === undefined || dto.content !== undefined)
  @IsString()
  @Length(1, LIMITS.MESSAGE_CHARS)
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.URL_CHARS)
  mediaUrl?: string;

  @ValidateIf((dto: MessageBody) => dto.mediaUrl !== undefined)
  @IsIn(['image', 'gif', 'video'])
  mediaType?: 'image' | 'gif' | 'video';

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.URL_CHARS)
  thumbnailUrl?: string;

  // A new UUID per message, reused on retry: a retried send is stored and delivered once.
  @IsOptional()
  @IsUuidLike()
  clientMessageId?: string;
}

export class DmOpenDto {
  // A user id, username or login code.
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  userId!: string;

  // An optional first message.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, LIMITS.MESSAGE_CHARS)
  content?: string;

  // Chat MAIN "SO / Merchants … sorted separately by apps": the merchant app this chat is about.
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'appId must be an app id' })
  appId?: string;
}

export class DmSendDto extends MessageBody {}

// The socket `dm_send` carries the conversation too.
export class DmSocketSendDto extends MessageBody {
  @IsUuidLike()
  conversationId!: string;
}

export class DmTypingDto {
  @IsUuidLike()
  conversationId!: string;

  @IsBoolean()
  typing!: boolean;
}

export class DmReadDto {
  @IsUuidLike()
  conversationId!: string;

  @IsUuidLike()
  messageId!: string;
}

export class DmReadBodyDto {
  @IsUuidLike()
  messageId!: string;
}

export class DmListQueryDto extends Page {
  @IsOptional()
  @IsIn(['PRIMARY', 'GENERAL', 'GROUPS', 'MERCHANT', 'CHANNELS', 'REQUESTS'])
  folder?: string;

  // MERCHANT folder only: one app's chats.
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'appId must be an app id' })
  appId?: string;
}

export class DmPageQueryDto extends Page {}

export class DmSearchQueryDto extends Page {
  @Transform(trim)
  @IsString()
  q!: string;

  @IsOptional()
  @IsUuidLike()
  conversationId?: string;
}

export class DmSharedQueryDto extends Page {
  @IsOptional()
  @IsIn(['media', 'links'])
  kind?: 'media' | 'links';
}

export class DmFolderDto {
  @IsIn(['PRIMARY', 'GENERAL'])
  folder!: 'PRIMARY' | 'GENERAL';
}

export class DmPinDto {
  @IsBoolean()
  pinned!: boolean;
}

export class DmNicknameDto {
  @ValidateIf((_dto, value) => value !== null)
  @Transform(trim)
  @IsString()
  @Length(1, 32)
  nickname!: string | null;
}

export class DmNotificationsDto {
  @IsIn(['DEFAULT', 'ON', 'OFF'])
  notifications!: 'DEFAULT' | 'ON' | 'OFF';
}

export class DmForwardDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @Matches(UUID_SHAPE, { each: true, message: 'each conversation id must be a UUID' })
  conversationIds!: string[];
}

// A gift card sent in a conversation. `clientMessageId` makes a retry safe.
export class DmCardDto {
  @IsString()
  @Length(1, 64)
  couponId!: string;

  @IsUuidLike()
  clientMessageId!: string;
}

export class DmGiftDto {
  @Matches(/^\d{1,18}(\.\d{1,18})?$/, { message: 'amount must be a positive decimal string' })
  amount!: string;

  @Matches(/^[A-Za-z0-9]{2,12}$/, { message: 'currency must be a code such as USDT' })
  currency!: string;
}

export class DmPrivacyDto {
  @IsOptional()
  @IsIn(['ALL', 'FRIENDS', 'NOBODY'])
  lastSeenVisibility?: 'ALL' | 'FRIENDS' | 'NOBODY';

  @IsOptional()
  @IsIn(['ALL', 'FRIENDS', 'NOBODY'])
  commonGroupsVisibility?: 'ALL' | 'FRIENDS' | 'NOBODY';

  @IsOptional()
  @IsBoolean()
  notifyPrimary?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyGeneral?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyGroups?: boolean;

  @IsOptional()
  @IsIn(['AUTO_NIGHT', 'OFF', 'CUSTOM'])
  quietMode?: 'AUTO_NIGHT' | 'OFF' | 'CUSTOM';

  @IsOptional()
  @Matches(HHMM, { message: 'quietStart must be HH:MM' })
  quietStart?: string;

  @IsOptional()
  @Matches(HHMM, { message: 'quietEnd must be HH:MM' })
  quietEnd?: string;

  // The one switch for "typing..." and read receipts, in both directions.
  @IsOptional()
  @IsBoolean()
  typingReceiptsEnabled?: boolean;
}

// Groups
export class GroupCreateDto {
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.URL_CHARS)
  logoUrl?: string;

  @IsIn(['PUBLIC', 'PRIVATE'])
  visibility!: 'PUBLIC' | 'PRIVATE';

  // A channel: only admins post. It is public or private like any group.
  @IsOptional()
  @IsBoolean()
  isChannel?: boolean;

  // Users to invite: ids, usernames or login codes.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  inviteUserIds?: string[];
}

export class GroupUpdateDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  name?: string;

  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsString()
  @MaxLength(LIMITS.URL_CHARS)
  logoUrl?: string | null;

  @IsOptional()
  @IsIn(['PUBLIC', 'PRIVATE'])
  visibility?: 'PUBLIC' | 'PRIVATE';

  @IsOptional()
  @IsBoolean()
  membersCanText?: boolean;
}

export class GroupPermissionsDto {
  // Each group permission → the lowest role allowed it, e.g. { "ADD_PEOPLE": "MEMBER" }.
  @IsOptional()
  @IsObject()
  permissions?: Record<string, 'OWNER' | 'ADMIN' | 'SUB_ADMIN' | 'MEMBER'>;

  // The permissions group admins may change (owner only, ).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  adminManageable?: string[];
}

export class GroupsQueryDto extends Page {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  q?: string;
}

export class GroupInviteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  userIds!: string[];
}

export class GroupInviteAnswerDto {
  @IsBoolean()
  accept!: boolean;
}

export class GroupRoleDto {
  @IsIn(['ADMIN', 'SUB_ADMIN', 'MEMBER'])
  role!: 'ADMIN' | 'SUB_ADMIN' | 'MEMBER';
}

export class GroupTimeoutDto {
  // Minutes, or null to end the timeout.
  @ValidateIf((_dto, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(60 * 24 * 30)
  minutes!: number | null;
}

export class GroupBanDto {
  @IsBoolean()
  banned!: boolean;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  reason?: string;
}

export class GroupTransferDto {
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  userId!: string;
}

export class DmReportDto {
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/)
  reason!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  details?: string;
}
