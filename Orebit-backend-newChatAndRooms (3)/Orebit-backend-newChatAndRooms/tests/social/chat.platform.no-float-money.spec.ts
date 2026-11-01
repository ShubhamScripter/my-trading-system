import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Rulebook B-1 / FR-004 / FR-181: money is never rounded and never a float. Every cut, share and percent goes through
 * platform/money.ts; nothing else in chat may call toFixed or Math.round. (Counting seconds with Math.ceil is not
 * money and is allowed.)
 */
const ROOT = join(__dirname, '..', '..', 'src', 'social', 'chat');
const FORBIDDEN = [/\.toFixed\(\s*\d/, /\bMath\.round\(/, /\bparseFloat\(/];
const ALLOWED = new Set([join(ROOT, 'platform', 'money.ts')]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('no float money in chat', () => {
  it('uses platform/money for every cut, share and percent', () => {
    const offenders: string[] = [];
    for (const file of files(ROOT)) {
      if (ALLOWED.has(file)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (FORBIDDEN.some((pattern) => pattern.test(line))) {
            offenders.push(`${file.slice(ROOT.length + 1)}:${index + 1}  ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
