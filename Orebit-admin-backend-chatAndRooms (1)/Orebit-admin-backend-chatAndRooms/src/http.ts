import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType, ZodTypeDef } from 'zod';
import { ERR, PROBLEM_CATALOGUE, type ErrorType } from './contracts';

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
  /** Machine-readable extras a client needs to act on the error — e.g.
   *  `attemptsRemaining` on a wrong code, or `resendAvailableAt` on a cooldown. */
  readonly extra?: Record<string, unknown>;
  /**
   * How long the caller must wait, in seconds.
   *
   * Sent BOTH ways: as the `Retry-After` header and as `retryAfterSeconds` in the
   * problem body. The header alone is not readable by the admin panel — it is a
   * cross-origin caller, and a response header is invisible to browser JavaScript
   * unless CORS names it in `Access-Control-Expose-Headers` (src/cors.ts does).
   * The body field is the one a client can always parse, so it is the primary
   * source; the header stays for proxies, CLI callers and RFC 9110 conformance.
   *
   * Omitted entirely for a refusal with no wait attached — see the
   * `admin_login_manual_review` note in auth/services/credential.service.ts. Zero
   * would read as "retry immediately", which is the opposite of what that means.
   */
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

function extractHttpStatus(err: unknown): number | null {
  if (err instanceof HttpException) {
    return err.getStatus();
  }
  if (typeof err === 'object' && err !== null) {
    const candidate =
      (err as { statusCode?: unknown }).statusCode ??
      (err as { status?: unknown }).status;
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= 400 &&
      candidate < 600
    ) {
      return candidate;
    }
  }
  return null;
}

function extractSafeDetail(err: unknown): string | undefined {
  if (err instanceof HttpException) {
    const res = err.getResponse();
    if (typeof res === 'string') return res;
    if (typeof res === 'object' && res !== null && 'message' in res) {
      const msg = (res as { message?: unknown }).message;
      if (typeof msg === 'string') return msg;
      if (Array.isArray(msg) && msg.every((m) => typeof m === 'string')) {
        return msg.join('; ');
      }
    }
  }
  if (err instanceof Error && typeof err.message === 'string') {
    return err.message;
  }
  return undefined;
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

  // Keep the host's body-size rejection; never expose its parser context.
  if (err instanceof HttpException && err.getStatus() === 413) {
    return { type: ERR.VALIDATION_FAILED, status: 413,
      title: PROBLEM_CATALOGUE[ERR.VALIDATION_FAILED].title,
      detail: 'Request body exceeds the allowed size.' };
  }

  // No SQLSTATE, no driver message, no stack trace ever reaches a client. The
  // real error is logged by the filter below instead — a Prisma error that got
  // this far would otherwise leak table and column names.
  const entry = PROBLEM_CATALOGUE[ERR.INTERNAL_ERROR];
  return { type: ERR.INTERNAL_ERROR, status: entry.status, title: entry.title };
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

    if (problem.status >= 500) this.logger.error({ err, requestId: req.id }, problem.title);
    else this.logger.warn({ type: problem.type, requestId: req.id }, problem.title);

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
      // The same number as the header above, and conditional for the same reason
      // the header is: a refusal with no wait must carry no duration at all.
      // `!== undefined` rather than a truthiness check — a genuine 0 (a cooldown
      // that has just this moment lapsed) is a number worth reporting, and `?? {}`
      // on a falsy value would silently drop it.
      ...(problem.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: problem.retryAfterSeconds }
        : {}),
    });
  }
}

/**
 * Parse-don't-validate, at the controller — the single place a request body is
 * checked. Every service method below it is typed against the parsed result and
 * trusts its input completely, which is only sound because this is the one door.
  *
 * The third type parameter on `ZodType` is `unknown` rather than `T`, and that is
 * load-bearing for any schema using `.default()`. Zod's `ZodType<Output, Def, Input>`
 * defaults `Input` to `Output`, so the bare `ZodType<T>` silently demands a schema
 * whose parsed shape equals its accepted shape - true of every schema here until the
 * first `.default()` appeared, at which point `T` was inferred as the INPUT type and
 * every optional-with-a-default field came back as possibly-undefined. `unknown` says
 * what is actually true: `safeParse` takes anything, and `T` is what comes out.
 */
export function parseDto<T>(schema: ZodType<T, ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ProblemException({
      type: ERR.VALIDATION_FAILED,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export interface SuccessEnvelope<T> {
  readonly data: T;
  readonly meta?: { readonly requestId: string };
}

export function ok<T>(data: T, requestId?: string): SuccessEnvelope<T> {
  return requestId ? { data, meta: { requestId } } : { data };
}
