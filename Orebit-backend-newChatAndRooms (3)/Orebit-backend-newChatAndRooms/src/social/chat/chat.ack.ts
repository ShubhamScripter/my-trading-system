import { Logger } from '@nestjs/common';
import { ERR, PROBLEM_CATALOGUE, type ErrorType } from '../../contracts';
import { ProblemException } from '../../http';

/** Formats WebSocket acknowledgements as `{ ok: true, data }` or standard `{ ok: false, error }` envelopes. */
export interface AckProblem {
  readonly type: ErrorType;
  readonly title: string;
  readonly detail?: string;
  readonly extra?: Record<string, unknown>;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
  readonly retryAfterSeconds?: number;
}

export interface AckSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export interface AckFailure {
  readonly ok: false;
  readonly error: AckProblem;
}

export type Ack<T> = AckSuccess<T> | AckFailure;

export function ackOk<T>(data: T): AckSuccess<T> {
  return { ok: true, data };
}

export function ackError(
  type: ErrorType,
  detail?: string,
  extra?: Record<string, unknown>,
  retryAfterSeconds?: number,
): AckFailure {
  return {
    ok: false,
    error: {
      type,
      title: PROBLEM_CATALOGUE[type].title,
      ...(detail === undefined ? {} : { detail }),
      ...(extra === undefined ? {} : { extra }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
}

export interface AckContext {
  readonly socketId?: string;
  readonly roomId?: string | null;
  readonly messageId?: string | null;
}

export function toAck(
  err: unknown,
  logger: Logger,
  event: string,
  userId?: string,
  context: AckContext = {},
): AckFailure {
  if (err instanceof ProblemException) {
    // A refusal is the system working; one debug line with its reason answers "why can't user X post in room Y".
    logger.debug(
      {
        component: 'ChatGateway',
        event,
        userId,
        ...context,
        type: err.type,
        reason: err.extra?.reason,
      },
      'socket event refused',
    );
    return {
      ok: false,
      error: {
        type: err.type,
        title: PROBLEM_CATALOGUE[err.type].title,
        ...(err.detail === undefined ? {} : { detail: err.detail }),
        ...(err.extra === undefined ? {} : { extra: err.extra }),
        ...(err.errors === undefined ? {} : { errors: err.errors }),
        ...(err.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: err.retryAfterSeconds }),
      },
    };
  }

  logger.error(
    { component: 'ChatGateway', err, event, userId, ...context },
    'unhandled error in socket handler',
  );
  return {
    ok: false,
    error: { type: ERR.INTERNAL_ERROR, title: PROBLEM_CATALOGUE[ERR.INTERNAL_ERROR].title },
  };
}
