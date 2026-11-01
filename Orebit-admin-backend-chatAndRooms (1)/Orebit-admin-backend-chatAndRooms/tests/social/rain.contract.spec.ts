import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RAIN_CONFIG, RAIN_CONTRACT_VERSION, RainConfigSchema } from '../../src/social/rain/rain.contract';

/**
 * The rain contract: the same fixture is run by the user backend against its byte-identical copy, so what the admin
 * panel saves and what the rain engine reads cannot drift apart. Each case deep-merges `patch` into `full`.
 */
interface Case {
  name: string;
  patch: Record<string, unknown>;
  valid: boolean;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'rain-contract.fixture.json'), 'utf8'),
) as { contractVersion: number; full: Record<string, unknown>; cases: Case[] };

function merge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = merge(out[key], value);
  }
  return out;
}

describe('rain contract fixture', () => {
  it('matches the contract version', () => {
    expect(fixture.contractVersion).toBe(RAIN_CONTRACT_VERSION);
  });

  it('accepts the defaults', () => {
    expect(RainConfigSchema.safeParse(DEFAULT_RAIN_CONFIG).success).toBe(true);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const result = RainConfigSchema.safeParse(merge(fixture.full, testCase.patch));
    expect(result.success).toBe(testCase.valid);
  });
});
