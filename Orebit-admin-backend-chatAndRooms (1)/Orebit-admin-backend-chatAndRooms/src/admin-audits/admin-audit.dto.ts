import { z } from 'zod';

import {
  decodeAdminAuditCursor,
  isCanonicalAdminAuditTimestamp,
} from './admin-audit.cursor.js';
import {
  DEPOSIT_ADMIN_AUDIT_ACTIONS,
  WALLET_CORE_ADMIN_AUDIT_ACTIONS,
  type AdminAuditHistoryQuery,
} from './admin-audit.types.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;

const uuidV7Schema = z.string().regex(UUID_V7).transform((value) => value.toLowerCase());
const subjectIdSchema = z.string().min(1).max(128).refine(
  (value) => value.trim() === value && !value.includes('\u0000'),
  'Invalid subject id.',
);
const timestampSchema = z.string().refine(
  isCanonicalAdminAuditTimestamp,
  'Invalid canonical UTC timestamp.',
);
const cursorSchema = z.string().min(1).max(512).refine((value) => {
  try {
    decodeAdminAuditCursor(value);
    return true;
  } catch {
    return false;
  }
}, 'Invalid cursor.');

export const adminAuditHistoryQuerySchema: z.ZodType<
  AdminAuditHistoryQuery,
  z.ZodTypeDef,
  {
    readonly domain?: 'WALLET_CORE' | 'DEPOSIT' | 'PRICE_CONVERSION';
    readonly action?: string;
    readonly actorId?: string;
    readonly runId?: string;
    readonly subjectType?: string;
    readonly subjectId?: string;
    readonly from?: string;
    readonly to?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }
> = z.object({
  domain: z.enum(['WALLET_CORE', 'DEPOSIT', 'PRICE_CONVERSION']).optional(),
  action: z.enum([
    ...WALLET_CORE_ADMIN_AUDIT_ACTIONS,
    ...DEPOSIT_ADMIN_AUDIT_ACTIONS,
  ]).optional(),
  actorId: uuidV7Schema.optional(),
  runId: uuidV7Schema.optional(),
  subjectType: z.string().regex(SUBJECT_TYPE).optional(),
  subjectId: subjectIdSchema.optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict().superRefine((query, context) => {
  if ((query.subjectType === undefined) !== (query.subjectId === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjectType'],
      message: 'subjectType and subjectId must be provided together.',
    });
  }
  if (query.from !== undefined && query.to !== undefined && query.from >= query.to) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'to must be later than from.',
    });
  }
});
