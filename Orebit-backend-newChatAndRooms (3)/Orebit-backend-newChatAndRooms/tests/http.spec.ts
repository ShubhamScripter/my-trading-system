import { Body, Controller, Logger, Post } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { emailVerifySchema } from '../src/settings/email/email.dto';
import { ProblemException, ProblemJsonFilter, ok, parseDto } from '../src/http';

/**
 * What a rejected request writes to the log.
 *
 * The filter logs the failing payload so a `validation_failed` can be diagnosed
 * from the log alone, which makes the log a place secrets can now end up. These
 * are the tests that say they do not: the interesting assertion is not that
 * `password` is censored — it is `expect(serialised).not.toContain(...)` over the
 * whole line, which fails for a secret reached by any path, including one nested
 * where pino's one-level `redact` in src/logger.ts would never look.
 */

const schema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    otp: z.string().length(6),
    profile: z.object({ country: z.string().length(2) }).optional(),
  })
  .strict();

@Controller('scrubbed')
class ScrubbedRoutes {
  @Post()
  post(@Body() body: unknown): { data: z.infer<typeof schema> } {
    return ok(parseDto(schema, body));
  }
}

let app: NestFastifyApplication;
const warn = vi.spyOn(Logger.prototype, 'warn');

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ controllers: [ScrubbedRoutes] }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new ProblemJsonFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  warn.mockClear();
});

/** The structured object the filter passed to the logger, for the last warning. */
function logged(): Record<string, unknown> {
  expect(warn).toHaveBeenCalledTimes(1);
  const [line] = warn.mock.calls[0] as [Record<string, unknown>, string];
  return line;
}

async function reject(body: unknown): Promise<Record<string, unknown>> {
  await request(app.getHttpServer()).post('/scrubbed').send(body as object).expect(400);
  return logged();
}

describe('the log line for a rejected request', () => {
  it('names the route and every failing field', async () => {
    const line = await reject({ email: 'not-an-email', password: 'short', otp: '123456' });

    expect(line.type).toBe('validation_failed');
    expect(line.method).toBe('POST');
    expect(line.url).toBe('/scrubbed');
    expect(line.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'email' }),
        expect.objectContaining({ path: 'password' }),
      ]),
    );
  });

  it('carries the payload, so a wrong value is visible and not just a wrong field', async () => {
    const line = await reject({
      email: 'someone@example.test',
      password: 'long-enough-password',
      otp: '123456',
      profile: { country: 'GBR' },
    });

    expect(line.errors).toEqual([expect.objectContaining({ path: 'profile.country' })]);
    expect(line.body).toMatchObject({ profile: { country: 'GBR' } });
  });

  it('censors a secret at the top level', async () => {
    const line = await reject({ email: 'bad', password: 'hunter2hunter2', otp: '123456' });

    expect((line.body as Record<string, unknown>).password).toBe('[redacted]');
    expect(JSON.stringify(line)).not.toContain('hunter2');
  });

  it('censors a secret nested deeper than pino redaction reaches', async () => {
    // `.strict()` rejects the unknown key, which is what gets this body logged at
    // all. Two levels down is past `*.token`, so only the scrubber catches it.
    const line = await reject({
      email: 'someone@example.test',
      password: 'long-enough-password',
      otp: '123456',
      extra: { session: { refreshToken: 'rt-should-never-be-logged' } },
    });

    expect(JSON.stringify(line)).not.toContain('rt-should-never-be-logged');
  });

  it('censors a secret whose key differs only in case', async () => {
    const line = await reject({ email: 'bad', password: 'x', otp: '1', newPIN: '424242' });

    expect(JSON.stringify(line)).not.toContain('424242');
  });

  it('truncates a string long enough to bloat the line', async () => {
    const blob = 'A'.repeat(5_000);
    const line = await reject({ email: 'bad', password: 'x', otp: '1', blob });

    const value = (line.body as Record<string, unknown>).blob;
    expect(String(value)).toContain('5000 chars');
    expect(String(value).length).toBeLessThan(200);
  });

  it('stops recursing rather than walking an arbitrarily deep body', async () => {
    const line = await reject({
      email: 'bad',
      password: 'x',
      otp: '1',
      a: { b: { c: { d: { e: 'too deep to print' } } } },
    });

    expect(JSON.stringify(line)).not.toContain('too deep to print');
    expect(JSON.stringify(line)).toContain('[nested]');
  });

  it('censors a one-time code whose name only ends with "code"', async () => {
    const line = await reject({
      email: 'someone@example.test',
      password: 'long-enough-password',
      otp: '123456',
      currentEmailCode: '455435',
      newEmailCode: '532331',
    });

    const body = line.body as Record<string, unknown>;
    expect(body.currentEmailCode).toBe('[redacted]');
    expect(body.newEmailCode).toBe('[redacted]');
    expect(JSON.stringify(line)).not.toContain('455435');
  });

  it('leaves a code-shaped field that is not a secret readable', async () => {
    const line = await reject({
      email: 'someone@example.test',
      password: 'long-enough-password',
      otp: '123456',
      countryCode: 'GBR',
    });

    expect((line.body as Record<string, unknown>).countryCode).toBe('GBR');
  });

  it('caps a long array', async () => {
    const line = await reject({
      email: 'bad',
      password: 'x',
      otp: '1',
      items: Array.from({ length: 50 }, (_, i) => i),
    });

    const items = (line.body as Record<string, unknown>).items as unknown[];
    expect(items).toHaveLength(21);
    expect(items[20]).toBe('… 30 more');
  });
});

/**
 * A union that matches nothing reports one root issue reading "Invalid input",
 * with every member's real complaint buried in `unionErrors`. `parseDto` opens the
 * closest member instead, which is the difference between a 400 that names the
 * missing field and one that says only that the request was wrong somehow.
 */
describe('the issues reported for a union', () => {
  function issuesFor(schema: Parameters<typeof parseDto>[0], body: unknown) {
    try {
      parseDto(schema, body);
    } catch (err) {
      return (err as ProblemException).errors ?? [];
    }
    throw new Error('expected the body to be rejected');
  }

  const nested = z.union([
    z.object({ kind: z.literal('a'), first: z.string() }).strict(),
    z.object({ kind: z.literal('b'), second: z.string(), third: z.string() }).strict(),
  ]);

  it('names the field the closest member was missing', () => {
    expect(issuesFor(nested, { kind: 'a' })).toEqual([
      expect.objectContaining({ path: 'first' }),
    ]);
  });

  it('does not report the members the caller was never attempting', () => {
    // The `b` member fails on two fields. Reporting those beside `first` would ask
    // somebody filling in the `a` shape to supply `second` and `third`.
    const issues = issuesFor(nested, { kind: 'a' });
    expect(JSON.stringify(issues)).not.toContain('second');
  });

  it('opens a real union — the email verify body that produced "(root) Invalid input"', () => {
    // Exactly the body from the log: an authenticator change with no `totpCode`.
    const issues = issuesFor(emailVerifySchema, {
      challengeId: 'c7m282na_SzStqiULPo07pcp9wm7BREFcfAecvcp2_0',
      currentEmailCode: '455435',
      newEmailCode: '532331',
      method: 'authenticator',
    });

    expect(issues).toEqual([expect.objectContaining({ path: 'totpCode' })]);
  });
});
