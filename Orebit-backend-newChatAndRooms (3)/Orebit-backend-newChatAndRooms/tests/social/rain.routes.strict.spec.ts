import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** FR-174: no rain request takes a field it does not know (a client typo must not be silently ignored). */
describe('rain request schemas are strict', () => {
  const source = readFileSync(join(__dirname, '../../src/social/rain/rain.routes.ts'), 'utf8');
  it('every z.object in the routes ends in .strict()', () => {
    const objects = source.match(/z\s*\.object\(/g) ?? [];
    const strict = source.match(/\.strict\(\)/g) ?? [];
    expect(objects.length).toBeGreaterThan(0);
    expect(strict.length).toBe(objects.length);
    expect(source).not.toMatch(/\.passthrough\(\)|\.strip\(\)/);
  });
});
