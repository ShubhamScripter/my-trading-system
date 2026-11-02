import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodIssueCode, type ZodIssue, type ZodType } from 'zod';
import { config } from './config';
import { ERR, PROBLEM_CATALOGUE, type ErrorType } from './contracts';
import { SENSITIVE_KEYS } from './logger';

/**
 * The HTTP contract for the whole service.
 *
 * Success is `{ data, meta? }`. Failure is RFC 9457 `application/problem+json`
 * whose `type` is a slug from src/contracts.ts. There is exactly one exception
 * class and exactly one filter, so there is exactly one shape of error response —
 * a client can write one parser and one exhaustive switch.
 */

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ProblemInput {
  readonly type: ErrorType;
  /** Overrides the catalogue's default status, for the rare slug that is
   *  legitimately reused across two statuses. Most callers omit it. */
  readonly status?: number;
  readonly detail?: string;
  /** Only for validation_failed. */
  readonly errors?: readonly ValidationIssue[];
  /** Machine-readable extras a client needs to act on the error — e.g. the
   *  `registrationId` to resume at, or `resendAvailableAt` on a cooldown. */
  readonly extra?: Record<string, unknown>;
  /** Becomes the `Retry-After` header. */
  readonly retryAfterSeconds?: number;
}

/**
 * The one exception type thrown for an *expected* failure. Anything else
 * reaching the filter is by definition a bug, and is reported as
 * `internal_error` with nothing of its internals disclosed.
 */
export class ProblemException extends Error {
  readonly type: ErrorType;
  readonly status: number;
  readonly detail?: string;
  readonly errors?: readonly ValidationIssue[];
  readonly extra?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(input: ProblemInput) {
    const entry = PROBLEM_CATALOGUE[input.type];
    super(input.detail ?? entry.title);
    this.name = 'ProblemException';
    this.type = input.type;
    this.status = input.status ?? entry.status;
    this.detail = input.detail;
    this.errors = input.errors;
    this.extra = input.extra;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

interface Problem {
  readonly type: ErrorType;
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly errors?: readonly ValidationIssue[];
  readonly extra?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
}

function toProblem(err: unknown): Problem {
  if (err instanceof ProblemException) {
    return {
      type: err.type,
      status: err.status,
      title: PROBLEM_CATALOGUE[err.type].title,
      detail: err.detail,
      errors: err.errors,
      extra: err.extra,
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }

  // Fastify or Nest HTTP client errors (400-499) map to matching client problem rather than internal 500
  if (err && typeof err === 'object') {
    const code = ('status' in err && typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : ('statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : null));
    if (code !== null && code >= 400 && code < 500) {
      if (code === 404 || err instanceof NotFoundException) {
        const entry = PROBLEM_CATALOGUE[ERR.NOT_FOUND];
        return { type: ERR.NOT_FOUND, status: entry.status, title: entry.title };
      }
      if (code === 401) {
        const entry = PROBLEM_CATALOGUE[ERR.UNAUTHENTICATED];
        return { type: ERR.UNAUTHENTICATED, status: entry.status, title: entry.title };
      }
      if (code === 403) {
        const entry = PROBLEM_CATALOGUE[ERR.FORBIDDEN];
        return { type: ERR.FORBIDDEN, status: entry.status, title: entry.title };
      }
      if (code === 429) {
        const entry = PROBLEM_CATALOGUE[ERR.RATE_LIMITED];
        return { type: ERR.RATE_LIMITED, status: entry.status, title: entry.title };
      }
      const entry = PROBLEM_CATALOGUE[ERR.VALIDATION_FAILED];
      return {
        type: ERR.VALIDATION_FAILED,
        status: code,
        // The exception message may come from a library and can contain internal
        // details. Only catalogue text is part of the public error contract.
        title: entry.title,
      };
    }
  }

  // No SQLSTATE, no driver message, no stack trace ever reaches a client. The
  // real error is logged by the filter below instead — a Prisma error that got
  // this far would otherwise leak table and column names.
  const entry = PROBLEM_CATALOGUE[ERR.INTERNAL_ERROR];
  return { type: ERR.INTERNAL_ERROR, status: entry.status, title: entry.title };
}

const REDACTED = '[redacted]';
const SCRUB_MAX_DEPTH = 4;
const SCRUB_MAX_STRING = 120;
const SCRUB_MAX_ITEMS = 20;
const SECRET = new Set<string>(SENSITIVE_KEYS.map((key) => key.toLowerCase()));

/**
 * A key is secret if it merely ENDS with one of these, not only if it matches a
 * name exactly.
 *
 * Written after an exact-match list let `currentEmailCode` and `newEmailCode` —
 * two live one-time codes — through into a log line, because the list held `code`
 * and `otp` and neither is the whole of those names. Any codebase grows
 * `currentPassword`, `loginId`, `webhookSecret`; a scrubber that has to be told
 * each one has already failed by the time anybody notices.
 */
const SECRET_SUFFIXES = [
  'password',
  'token',
  'secret',
  'code',
  'otp',
  'pin',
  'key',
  'hash',
  'signature',
  'credential',
];

/**
 * Names that end in a secret suffix but carry nothing secret.
 *
 * A short, deliberate list — the default is to censor. These are here because
 * they are the values most worth SEEING in a rejected body (a country code is a
 * common validation failure and useless to an attacker) and because none of them
 * is a credential in this service.
 */
const NOT_SECRET = new Set([
  'countrycode',
  'postalcode',
  'zipcode',
  'currencycode',
  'languagecode',
  'dialcode',
  'publiccode',
  'referralcode',
  'statuscode',
  'errorcode',
  'sitekey',
]);

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (NOT_SECRET.has(lower)) return false;
  return SECRET.has(lower) || SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * A request payload reduced to something safe to write to a log.
 *
 * Knowing WHICH field failed is usually not enough to see why — "country: Unknown
 * country" is answered by seeing that the client sent `"UK"`. So the payload goes
 * in the line beside the issues, under four rules that make that affordable:
 *
 *  - a secret key is censored at every depth — matched case-insensitively and by
 *    suffix, so neither `newPIN` nor `currentEmailCode` slips past;
 *  - strings are truncated, because a rejected body can carry a 40KB base64 blob
 *    and a log line is not the place to find that out;
 *  - recursion stops at a fixed depth and arrays at a fixed length, so a hostile
 *    or merely deep body cannot turn one bad request into an unbounded write;
 *  - `Buffer`/typed arrays are summarised rather than expanded into a per-byte
 *    object, which is what JSON.stringify would otherwise do.
 *
 * This is the primary defence. `src/logger.ts` redacts the same names as a pino
 * backstop, but only one level deep — a secret nested inside an object inside the
 * body is caught here or not at all.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > SCRUB_MAX_STRING
      ? `${value.slice(0, SCRUB_MAX_STRING)}… (${String(value.length)} chars)`
      : value;
  }

  if (typeof value !== 'object') return value;

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary ${String(value.byteLength)} bytes]`;
  }

  if (depth >= SCRUB_MAX_DEPTH) return '[nested]';

  if (Array.isArray(value)) {
    const head = value.slice(0, SCRUB_MAX_ITEMS).map((item) => scrub(item, depth + 1));
    return value.length > SCRUB_MAX_ITEMS
      ? [...head, `… ${String(value.length - SCRUB_MAX_ITEMS)} more`]
      : head;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : scrub(item, depth + 1);
  }
  return out;
}

/** Omitted entirely when empty, so a line is not padded with `{}`. */
function payload(part: unknown): Record<string, unknown> | undefined {
  if (part === null || typeof part !== 'object') return undefined;
  const scrubbed = scrub(part);
  if (typeof scrubbed !== 'object' || scrubbed === null) return undefined;
  return Object.keys(scrubbed).length > 0 ? (scrubbed as Record<string, unknown>) : undefined;
}

/** Registered once, globally, in src/main.ts. */
@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemJsonFilter');

  catch(err: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();
    const problem = toProblem(err);

    if (problem.status >= 500) {
      this.logger.error({ err, requestId: req.id }, problem.title);
    } else {
      // The route and the failing fields, not just the slug. A bare
      // `validation_failed` line is undiagnosable on its own: `parseDto` below
      // already computes which paths failed and why, but that detail used to go
      // out in the response body and nowhere else, so the log could say only
      // that *something* about *some* request was malformed.
      //
      // `errors` carries Zod's `path` and `message` — never the submitted value,
      // with the one exception of Zod's own enum/literal wording, which quotes
      // the received member back ("...received 'x'"). No password, code or token
      // reaches a message that way; those fail on length or format rules, whose
      // messages describe the rule rather than the input.
      //
      // `req.url` is the same string already published to the client as
      // `instance` a few lines down, so it discloses nothing new.
      const line: Record<string, unknown> = {
        type: problem.type,
        requestId: req.id,
        method: req.method,
        url: req.url,
      };
      if (problem.errors) line.errors = problem.errors;

      // The payload that failed — scrubbed, and outside production only. The field
      // paths say what was wrong with the request; this says what the request WAS,
      // which is the difference between "country failed" and "the client is sending
      // 'UK'". Withheld in production because a rejected body is still user data and
      // a log aggregator is the wrong home for it, scrubbed or not.
      if (!config.isProduction && problem.type === ERR.VALIDATION_FAILED) {
        const body = payload(req.body);
        const query = payload(req.query);
        if (body) line.body = body;
        if (query) line.query = query;
      }

      this.logger.warn(line, problem.title);
    }

    const reply = res.status(problem.status).header('content-type', 'application/problem+json');
    if (problem.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(problem.retryAfterSeconds));
    }

    void reply.send({
      type: problem.type,
      title: problem.title,
      status: problem.status,
      ...(problem.detail !== undefined ? { detail: problem.detail } : {}),
      instance: req.url,
      requestId: req.id,
      ...(problem.errors ? { errors: problem.errors } : {}),
      ...(problem.extra ? { extra: problem.extra } : {}),
    });
  }
}

/**
 * Parse-don't-validate, at the controller — the single place a request body is
 * checked. Every service method below it is typed against the parsed result and
 * trusts its input completely, which is only sound because this is the one door.
 */
export function parseDto<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ProblemException({
      type: ERR.VALIDATION_FAILED,
      errors: flattenIssues(result.error.issues),
    });
  }
  return result.data;
}

/**
 * Zod's issues, with a `z.union` failure opened up instead of reported as itself.
 *
 * A union that matches no member produces ONE issue, at the root, reading "Invalid
 * input" — the per-member errors are buried in `unionErrors` and never reach the
 * client or the log. On a schema like `emailVerifySchema`, which unions the change
 * ceremony against the recovery one, that is the whole diagnosis thrown away: a
 * request missing `totpCode` is answerable in three words and instead says nothing
 * at all about which field is wrong.
 *
 * The member reported is the one with the FEWEST issues — the branch the caller
 * came closest to satisfying, which for a discriminated union nested inside a plain
 * one is reliably the branch their discriminant selected. Reporting every member's
 * issues instead would bury the one that matters under the four the caller was
 * never attempting: "recoveryId: Required" is not useful advice for somebody
 * halfway through an email change.
 *
 * Recursive because unions nest, and a `superRefine` on a union puts its own issues
 * a level down again.
 */
function flattenIssues(issues: readonly ZodIssue[]): ValidationIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code === ZodIssueCode.invalid_union && issue.unionErrors.length > 0) {
      const closest = issue.unionErrors.reduce((best, candidate) =>
        candidate.issues.length < best.issues.length ? candidate : best,
      );
      // A member that failed with no issues of its own cannot be described, so the
      // union's own "Invalid input" is still better than an empty `errors` array.
      if (closest.issues.length > 0) return flattenIssues(closest.issues);
    }

    return [{ path: issue.path.join('.') || '(root)', message: issue.message }];
  });
}

export interface SuccessEnvelope<T> {
  readonly data: T;
  readonly meta?: { readonly requestId: string };
}

export function ok<T>(data: T, requestId?: string): SuccessEnvelope<T> {
  return requestId ? { data, meta: { requestId } } : { data };
}
