import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import { ERR } from '../../contracts';
import { ProblemException, type ValidationIssue } from '../../http';

/**
 * The one validator for chat input, on both transports: every socket handler and every `@Body()` / `@Query()`
 * of the chat controller runs through it, so the same input gets the same `validation_failed` answer everywhere.
 *
 * Unknown fields are REFUSED, not stripped (`forbidNonWhitelisted`): a silently dropped field — the removed per-message
 * `hideIdentity`, a client-set `type` or `metadata` — would otherwise change what the sender meant without telling
 * them. It throws a `ProblemException`, so HTTP answers 400 problem+json and a socket ack carries the same slug and
 * `errors` of `{ path, message }`.
 *
 * No implicit conversion: numbers in query strings are converted by `@Type(() => Number)` on the DTO field.
 */
@Injectable()
export class WsValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const target = metadata.metatype;
    if (!target || !needsValidation(target)) return value;

    const input = value === undefined && metadata.type === 'query' ? {} : value;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: 'Payload must be an object',
      });
    }

    const instance = plainToInstance(target, input, { enableImplicitConversion: false });
    const errors = validateSync(instance as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    });

    if (errors.length > 0) {
      throw new ProblemException({ type: ERR.VALIDATION_FAILED, errors: flatten(errors) });
    }
    return instance;
  }
}

const PASSTHROUGH: unknown[] = [String, Boolean, Number, Array, Object];

function needsValidation(metatype: unknown): boolean {
  return !PASSTHROUGH.includes(metatype);
}

/** class-validator's nested errors as the `{ path, message }` pairs the Zod side produces. */
function flatten(errors: readonly ValidationError[], prefix = ''): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const error of errors) {
    const path = prefix === '' ? error.property : `${prefix}.${error.property}`;
    for (const message of Object.values(error.constraints ?? {})) out.push({ path, message });
    if (error.children && error.children.length > 0) out.push(...flatten(error.children, path));
  }
  return out;
}
