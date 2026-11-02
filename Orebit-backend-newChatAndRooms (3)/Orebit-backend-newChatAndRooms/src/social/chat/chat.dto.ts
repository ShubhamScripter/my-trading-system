import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsISO8601,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { LIMITS, PAGE } from './chat.constants';

// Every chat input, for both transports. Validated by `WsValidationPipe` (chat.ws.pipe.ts), which refuses unknown
// fields: a removed field such as the old per-message `hideIdentity`, `type` or `metadata` gets `validation_failed`
// instead of being silently dropped.
// Numbers in query strings are converted with `@Type(() => Number)`; the pipe does no implicit conversion.

// A UUID by shape. class-validator's IsUUID also checks the version digit, which refuses the fixed ids chat uses for
// seeded rows (the Global room, the default skin: 00000000-…-000000000001), so a seeded skin could not be equipped.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IsUuidLike = (): PropertyDecorator =>
  Matches(UUID_SHAPE, { message: '$property must be a UUID' });

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// A room by UUID or slug (never by display name).
class RoomRef {
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  roomId!: string;
}

class PageQuery {
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

// Socket payloads
export class SendMessageDto {
  @IsOptional()
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  roomId?: string;

  // Plain text as typed; at most 4,000 characters after trimming. Optional with media (the caption).
  @Transform(trim)
  @ValidateIf((dto: SendMessageDto) => dto.mediaUrl === undefined || dto.content !== undefined)
  @IsString()
  @Length(1, LIMITS.MESSAGE_CHARS)
  content?: string;

  @IsOptional()
  @IsUuidLike()
  skinId?: string;

  // A new UUID per message, reused on retry: a retried send is stored and broadcast once.
  @IsOptional()
  @IsUuidLike()
  clientMessageId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.URL_CHARS)
  mediaUrl?: string;

  @ValidateIf((dto: SendMessageDto) => dto.mediaUrl !== undefined)
  @IsIn(['image', 'gif', 'video'])
  mediaType?: 'image' | 'gif' | 'video';

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.URL_CHARS)
  thumbnailUrl?: string;
}

export class JoinRoomDto extends RoomRef {}

export class LeaveRoomDto {
  @IsOptional()
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  roomId?: string;
}

export class RetractMessageDto {
  @IsUuidLike()
  messageId!: string;

  // Optional on an author's own retract; shown only to the affected user.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, LIMITS.NOTE_CHARS)
  note?: string;
}

export class OnlineUsersDto extends PageQuery {
  @IsOptional()
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  roomId?: string;

  // Username prefix search.
  @IsOptional()
  @IsString()
  @Length(1, 24)
  prefix?: string;
}

// HTTP bodies and queries
export class PageQueryDto extends PageQuery {}

// Which list of report reasons: a message or request (the default), or a user profile.
export class ReportReasonsQueryDto {
  @IsOptional()
  @IsIn(['MESSAGE', 'USER'])
  type?: 'MESSAGE' | 'USER';
}

// The caller's own limitations: newest first, with an optional date range.
export class LimitationsQueryDto extends PageQuery {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export class MembersQueryDto extends PageQuery {
  @IsOptional()
  @IsString()
  @Length(1, 24)
  prefix?: string;
}

export class GetMessagesQueryDto extends PageQuery {
  // Messages newer than this one, oldest first, for a reconnecting client. Not with `cursor`.
  @IsOptional()
  @IsUuidLike()
  after?: string;
}

export class PreferencesQueryDto {
  // The last room the browser remembers (Chat MAIN: saved "in their LS or Cookies").
  @IsOptional()
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  lastRoomId?: string;
}

export class UpdateChatPreferenceDto {
  // The profile-level "hide identity" setting (Chat MAIN "hide their identity from profile settings").
  @IsOptional()
  @IsBoolean()
  hideIdentity?: boolean;

  // A skin the user may use, or null for none.
  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsUuidLike()
  activeSkinId?: string | null;
}

export class SendMediaMessageDto {
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  roomId!: string;

  @IsString()
  @MaxLength(LIMITS.URL_CHARS)
  mediaUrl!: string;

  @IsIn(['image', 'gif', 'video'])
  mediaType!: 'image' | 'gif' | 'video';

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, LIMITS.CAPTION_CHARS)
  caption?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.URL_CHARS)
  thumbnailUrl?: string;

  @IsOptional()
  @IsUuidLike()
  skinId?: string;

  @IsOptional()
  @IsUuidLike()
  clientMessageId?: string;
}

export class NoteBodyDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, LIMITS.NOTE_CHARS)
  note?: string;
}

export class ReportDto {
  // A code from GET social/chat/report-reasons.
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/)
  reason!: string;

  // Optional: an empty box counts as no details.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === ''
      ? undefined
      : typeof value === 'string'
        ? value.trim()
        : value,
  )
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  details?: string;
}

// A group of users (Premium, KYC, or a minimum level) that a role with Group Privilege may act on.
export class GroupTargetDto {
  @IsIn(['PREMIUM', 'KYC', 'LEVEL'])
  targetType!: 'PREMIUM' | 'KYC' | 'LEVEL';

  // LEVEL: the minimum level, a whole number. PREMIUM and KYC: any value.
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  targetValue!: string;
}

export class WarnUserDto {
  // One user, or `group`: exactly one of the two (checked by the service).
  @ValidateIf((dto: WarnUserDto) => dto.group === undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  userId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GroupTargetDto)
  group?: GroupTargetDto;

  @IsOptional()
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  roomId?: string;

  // Required, for staff and the audit; never shown to the user.
  @Transform(trim)
  @IsString()
  @Length(1, LIMITS.NOTE_CHARS)
  internalReason!: string;

  // Optional: the only reason the user sees (notice and own list), never the internal one.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, LIMITS.NOTE_CHARS)
  userReason?: string;
}

export class BanUserDto {
  // One user, or `group`: exactly one of the two (checked by the service).
  @ValidateIf((dto: BanUserDto) => dto.group === undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  userId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GroupTargetDto)
  group?: GroupTargetDto;

  @IsOptional()
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  roomId?: string;

  // Required, for staff and the audit; never shown to the user.
  @Transform(trim)
  @IsString()
  @Length(1, LIMITS.NOTE_CHARS)
  internalReason!: string;

  // Optional: the only reason the user sees (notice and own list), never the internal one.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, LIMITS.NOTE_CHARS)
  userReason?: string;

  // 1 to the chat setting `limits.maxBanHours`; checked against the setting by the service.
  @ValidateIf((dto: BanUserDto) => dto.permanent !== true)
  @IsInt()
  @Min(1)
  @Max(24 * 365 * 10)
  durationHours?: number;

  @IsOptional()
  @Equals(true)
  permanent?: true;
}
