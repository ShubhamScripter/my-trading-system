import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { SUPPORT_STATUSES, SUPPORT_SUBJECT_MAX, type SupportStatus } from '../chat.contract';
import { LIMITS, PAGE } from '../chat.constants';

/** Inputs of the support chat (Module 10), validated like every chat input: unknown fields are refused. */

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

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

export class SupportCreateDto {
  @Transform(trim)
  @IsString()
  @Length(1, SUPPORT_SUBJECT_MAX)
  subject!: string;

  @Transform(trim)
  @IsString()
  @Length(1, LIMITS.MESSAGE_CHARS)
  content!: string;
}

export class SupportMessageDto {
  @Transform(trim)
  @IsString()
  @Length(1, LIMITS.MESSAGE_CHARS)
  content!: string;
}

export class SupportListQueryDto extends Page {
  @IsOptional()
  @IsIn(SUPPORT_STATUSES)
  status?: SupportStatus;
}

export class SupportMessagesQueryDto extends Page {}
