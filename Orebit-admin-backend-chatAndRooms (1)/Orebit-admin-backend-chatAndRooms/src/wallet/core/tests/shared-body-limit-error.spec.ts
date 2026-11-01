import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { ArgumentsHost } from '../../../../node_modules/@nestjs/common/index.js';
import { ProblemException, ProblemJsonFilter } from '../../../http.js';

// Use the host's Nest copy, which also creates its transport exceptions.
const hostRequire = createRequire(require.resolve('../../../http.js'));
const { HttpException, Logger } = hostRequire('@nestjs/common');
Logger.overrideLogger(false);

function responseFor(error: unknown) {
  let status = 0;
  let body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const reply = {
    status(value: number) { status = value; return this; },
    header(name: string, value: string) { headers[name] = value; return this; },
    send(value: Record<string, unknown>) { body = value; },
  };
  const host = { switchToHttp: () => ({
    getResponse: () => reply,
    getRequest: () => ({ id: 'body-limit-test', url: '/v1/admin/wallet/core' }),
  }) } as ArgumentsHost;
  new ProblemJsonFilter().catch(error, host);
  return { status, body, headers };
}

test('host body-limit exceptions retain 413 without exposing the exception payload', () => {
  const result = responseFor(new HttpException({ message: 'private parser context' }, 413));
  assert.equal(result.status, 413);
  assert.equal(result.body.status, 413);
  assert.equal(result.body.type, 'validation_failed');
  assert.equal(result.headers['content-type'], 'application/problem+json');
  assert.equal(JSON.stringify(result.body).includes('private parser context'), false);
  assert.equal(result.body.requestId, 'body-limit-test');
});

test('the narrow exception mapping does not trust arbitrary status objects or change other errors', () => {
  for (const error of [{ status: 413, message: 'private parser context' },
    { statusCode: 413 }, new HttpException('private parser context', 400), new Error('private parser context')]) {
    const result = responseFor(error);
    assert.equal(result.status, 500);
    assert.equal(result.body.type, 'internal_error');
    assert.equal(JSON.stringify(result.body).includes('private parser context'), false);
  }
  const existing = responseFor(new ProblemException({ type: 'validation_failed', detail: 'Known validation' }));
  assert.equal(existing.status, 400);
  assert.equal(existing.body.detail, 'Known validation');
});
