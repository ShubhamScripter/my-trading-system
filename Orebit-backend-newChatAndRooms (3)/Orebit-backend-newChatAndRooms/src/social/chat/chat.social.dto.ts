import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  CHAT_COMMANDS,
  RESTRICTION_KINDS,
  RESTRICTION_TARGETS,
  ROOM_STATUSES,
} from './chat.contract';
import { LIMITS, PAGE } from './chat.constants';

// Inputs of the Module 4 staff tools and the Module 5 commands, ads and gifts. Validated by `WsValidationPipe`, which
// refuses unknown fields, like every chat input (chat.dto.ts).

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const emptyToUndefined = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === ''
    ? undefined
    : typeof value === 'string'
      ? value.trim()
      : value;

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

// The text box a staff member fills when asking a higher role (REPORT mode), or a note on an action.
class WithNote {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @Length(1, 1000)
  note?: string;
}

// Module 4: staff tools
export class StaffRestrictDto extends WithNote {
  @IsIn(RESTRICTION_TARGETS)
  targetType!: (typeof RESTRICTION_TARGETS)[number];

  // USER: an id, username or login code. LEVEL: the minimum level. PREMIUM / KYC: any value.
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  targetValue!: string;

  @IsIn(RESTRICTION_KINDS)
  kind!: (typeof RESTRICTION_KINDS)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CHAT_COMMANDS.length)
  @IsIn(CHAT_COMMANDS, { each: true })
  commands?: (typeof CHAT_COMMANDS)[number][];

  @IsOptional()
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  roomId?: string;

  // Required, for staff and the audit; never shown to the user.
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  internalReason!: string;

  // Optional: the only reason the user sees (notice and own list), never the internal one.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  userReason?: string;

  // A length of at least one hour. Permanent is said with `permanent: true`; giving neither is refused.
  @ValidateIf((o: StaffRestrictDto) => o.permanent !== true)
  @IsInt()
  @Min(1)
  @Max(24 * 365 * 10)
  durationHours?: number;

  @IsOptional()
  @Equals(true)
  permanent?: true;
}

export class StaffRoomStatusDto extends WithNote {
  @IsIn(ROOM_STATUSES)
  status!: (typeof ROOM_STATUSES)[number];
}

export class StaffRulesDto extends WithNote {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  rules!: string[];
}

export class StaffRoomAccessDto extends WithNote {
  @Matches(UUID_SHAPE, { message: 'userId must be a UUID' })
  userId!: string;

  // ADD lets the user in whatever the room's gates say; REMOVE shuts them out; RESTORE undoes either.
  @IsIn(['ADD', 'REMOVE', 'RESTORE'])
  action!: 'ADD' | 'REMOVE' | 'RESTORE';
}

// "Disable / Enable Sending Money from Chat".
export class StaffGiftsDto extends WithNote {
  @IsBoolean()
  enabled!: boolean;
}

// "Check Chat Banned / Penalised Users List: Edit" a ban: a new end counted from now, or permanent.
export class BanChangeDto extends WithNote {
  @ValidateIf((o: BanChangeDto) => o.permanent !== true)
  @IsInt()
  @Min(1)
  @Max(24 * 365 * 10)
  durationHours?: number;

  @IsOptional()
  @Equals(true)
  permanent?: true;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  internalReason?: string;

  // Optional: the only reason the user sees (notice and own list), never the internal one.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  userReason?: string;
}

// Edit a restriction: a new end counted from now (`durationHours`, at least 1), `permanent: true` for until lifted, or
// neither to keep the end it has (a change of the reason alone never moves the end).
export class RestrictionChangeDto extends WithNote {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 365 * 10)
  durationHours?: number;

  @IsOptional()
  @Equals(true)
  permanent?: true;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  internalReason?: string;

  // Optional: the only reason the user sees (notice and own list), never the internal one.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  userReason?: string;
}

export class BotLogQueryDto extends Page {}

// "View User History": one feature (Faucet, SL…), or every feature the role may see when absent.
export class UserHistoryQueryDto extends Page {
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,40}$/, { message: 'feature must be a feature id such as FAUCET' })
  feature?: string;
}

export class StaffCommandsDto extends WithNote {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CHAT_COMMANDS.length)
  @IsIn(CHAT_COMMANDS, { each: true })
  disabled?: (typeof CHAT_COMMANDS)[number][];
}

export class ReportsQueryDto extends Page {
  @IsOptional()
  @IsIn(['PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED', 'ALL'])
  status?: string;
}

export class ReportActionDto extends WithNote {
  @IsIn(['DISMISS', 'WARN', 'BAN', 'RETRACT_MESSAGE'])
  action!: 'DISMISS' | 'WARN' | 'BAN' | 'RETRACT_MESSAGE';

  // Optional: the only reason the user sees (notice and own list), never the internal one.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  userReason?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 365 * 10)
  durationHours?: number;

  @IsOptional()
  @Equals(true)
  permanent?: true;
}

export class PenaltiesQueryDto {
  @IsOptional()
  @Matches(UUID_SHAPE, { message: 'userId must be a UUID' })
  userId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGE.MAX)
  limit?: number;

  // The `nextBefore` of the previous page.
  @IsOptional()
  @IsString()
  @Length(1, 40)
  before?: string;
}

export class RequestsQueryDto extends Page {
  @IsOptional()
  @IsIn(['TO_RESOLVE', 'MINE'])
  scope?: 'TO_RESOLVE' | 'MINE';
}

export class ResolveRequestDto extends WithNote {
  @IsBoolean()
  approve!: boolean;
}

export class HistoryQueryDto extends Page {}

// Module 5: commands, mute and block, ads, gifts
export class CommandDto {
  @IsOptional()
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  roomId?: string;

  // The command as typed, e.g. `/mute @bob`.
  @Transform(trim)
  @IsString()
  @Length(2, LIMITS.MESSAGE_CHARS)
  text!: string;
}

export class RelationListQueryDto extends Page {}

export class AdDto {
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  content!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(1, LIMITS.ROOM_REF_CHARS, { each: true })
  roomIds?: string[];

  @IsOptional()
  @IsBoolean()
  allRooms?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  pinMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  repeatCount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  repeatGapMinutes?: number;

  @IsOptional()
  @Matches(/^[a-z0-9_-]{1,32}$/)
  badgeId?: string;

  // One of the ad skins the admin offers.
  @IsOptional()
  @Matches(/^[a-z0-9_-]{1,32}$/)
  skinId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @Matches(/^[A-Za-z]{2}$/, { each: true })
  hiddenCountries?: string[];

  // One key per ad purchase (8 to 64 letters, digits, - or _), sent again unchanged when the request is retried: the same
// key and request give the first answer and one charge; the same key with another request is a 409. Required to buy
// an ad; a quote does not use it.
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: 'idempotencyKey must be 8 to 64 letters, digits, - or _' })
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  paymentPin?: string;

  @IsOptional()
  @IsBoolean()
  is18Plus?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  currencies?: string[];
}

// Cancelling an ad: the coin to be refunded in, one of the admin's refund currencies (when the admin offers any).
export class AdCancelDto {
  @IsOptional()
  @Matches(/^[A-Za-z0-9]{2,12}$/, { message: 'refundCurrency must be a currency code such as USDT' })
  refundCurrency?: string;
}

export class GiftStartDto {
  // A user id, username or login code.
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  recipient!: string;

  @Matches(/^\d{1,18}(\.\d{1,18})?$/, { message: 'amount must be a positive decimal string' })
  amount!: string;

  @Matches(/^[A-Za-z0-9]{2,12}$/, { message: 'currency must be a code such as USDT' })
  currency!: string;

  // The public room the notice goes to.
  @IsOptional()
  @IsString()
  @Length(1, LIMITS.ROOM_REF_CHARS)
  roomId?: string;
}

export class GiftConfirmDto {
  // The payment PIN or 2FA code, as the gift's `verification` says.
  @Transform(trim)
  @IsString()
  @Length(4, 12)
  code!: string;
}
