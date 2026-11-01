#!/usr/bin/env node
/**
 * The dependency-audit gate.
 *
 * `npm audit --audit-level=high` on its own would be the whole job, and it is not
 * usable here for one reason: there is currently a high-severity advisory in the
 * tree with NO released fix. A gate that cannot pass is a gate people route around,
 * and the first thing they route around it for is the real finding.
 *
 * So this wraps `npm audit --json` with an allowlist that has three properties the
 * bare command cannot give:
 *
 *   a REASON     every exception says why, in the file, next to the id.
 *   an EXPIRY    an exception stops working on a date. Reaching that date fails the
 *                build, which is the only reliable way to make someone look again.
 *   STALENESS    an allowlist entry that no longer matches anything fails too, so
 *                exceptions are deleted when they are fixed rather than accumulating
 *                as a list nobody reads.
 *
 * The last two are what keep this from becoming a permanent mute button.
 *
 * Usage:
 *   node scripts/audit.mjs              production dependencies, fails on high+
 *   node scripts/audit.mjs --all        include devDependencies
 *   node scripts/audit.mjs --level=critical
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Advisories we are knowingly shipping with, and until when.
 *
 * Adding an entry is a decision to accept a risk. Keep the reason specific enough
 * that the next person can re-evaluate it without re-deriving the analysis.
 */
const ALLOWLIST = [
  {
    id: 'GHSA-ggr8-5vv4-36mx',
    package: 'deepmerge-ts',
    until: '2026-12-01',
    reason:
      'Stack exhaustion merging recursive object graphs. Reached only through ' +
      '@prisma/config, which is the Prisma CLI parsing a developer-authored config ' +
      'file at build time — not request handling, and not attacker-influenced. No ' +
      'released Prisma fixes it: the advisory range covers every published 6.x and ' +
      '7.x. Appears in the production tree only because @prisma/client declares ' +
      'prisma as an optional peer; the package is a devDependency and is never ' +
      'loaded by the running service. Revisit when Prisma ships on deepmerge-ts 8.',
  },
];

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

const args = process.argv.slice(2);
const includeDev = args.includes('--all');
const level = (args.find((a) => a.startsWith('--level='))?.split('=')[1] ?? 'high').toLowerCase();
const threshold = SEVERITY_ORDER.indexOf(level);

if (threshold === -1) {
  console.error(`Unknown --level=${level}. Expected one of: ${SEVERITY_ORDER.join(', ')}`);
  process.exit(2);
}

/**
 * `npm audit` exits non-zero when it finds anything, so a rejection here is the
 * normal case rather than an error. What matters is that we got parseable JSON;
 * anything else is a real failure and must not be read as "no vulnerabilities".
 */
async function audit() {
  const argv = ['audit', '--json', ...(includeDev ? [] : ['--omit=dev'])];
  // Windows needs a shell to run npm at all — npm ships as `npm.cmd`, and since
  // Node 20 a bare `execFile` of a `.cmd` fails with EINVAL rather than running it.
  // The escaping concern behind that change does not apply here: every argument
  // above is a literal in this file, none is derived from input. CI runs on Linux
  // and takes the plain path.
  const win = process.platform === 'win32';
  try {
    const { stdout } = await run(win ? 'npm.cmd' : 'npm', argv, {
      shell: win,
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (err) {
    if (typeof err.stdout === 'string' && err.stdout.trim().startsWith('{')) {
      return JSON.parse(err.stdout);
    }
    console.error('npm audit did not return JSON. Treating this as a failure.');
    console.error(err.stderr || err.message);
    process.exit(2);
  }
}

/** Every advisory in the report, flattened to one row each. */
function findings(report) {
  const rows = [];
  for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      // A string `via` is a transitive pointer at another package's advisory; the
      // object form is the advisory itself. Counting both would double-report.
      if (typeof via !== 'object') continue;
      rows.push({
        package: name,
        id: via.url?.split('/').pop() ?? String(via.source ?? 'unknown'),
        title: via.title ?? '(no title)',
        severity: via.severity ?? vuln.severity,
      });
    }
  }
  return rows;
}

const report = await audit();
const all = findings(report);
const today = new Date().toISOString().slice(0, 10);

const problems = [];
const suppressed = [];
const matched = new Set();

for (const row of all) {
  if (SEVERITY_ORDER.indexOf(row.severity) < threshold) continue;

  const exception = ALLOWLIST.find((e) => e.id === row.id);
  if (exception === undefined) {
    problems.push(row);
    continue;
  }

  matched.add(exception.id);
  if (exception.until < today) {
    problems.push({ ...row, note: `allowlist entry EXPIRED on ${exception.until}` });
  } else {
    suppressed.push({ ...row, until: exception.until });
  }
}

// An exception that matches nothing has been fixed, or the package is gone. Either
// way the entry is now a lie about what we are accepting, so it fails the build
// until it is deleted.
const stale = ALLOWLIST.filter((e) => !matched.has(e.id));

const scope = includeDev ? 'all dependencies' : 'production dependencies';
console.log(`Audited ${scope}; failing on ${level} and above.\n`);

for (const s of suppressed) {
  console.log(`  ALLOWED   ${s.severity.padEnd(8)} ${s.package} ${s.id} (until ${s.until})`);
}
for (const p of problems) {
  console.log(`  FAIL      ${p.severity.padEnd(8)} ${p.package} ${p.id} — ${p.title}`);
  if (p.note) console.log(`            ${p.note}`);
}
for (const s of stale) {
  console.log(`  STALE     allowlist entry ${s.id} (${s.package}) no longer matches — remove it`);
}

if (problems.length === 0 && stale.length === 0) {
  console.log(`\nOK — ${suppressed.length} allowed, 0 unaccounted for.`);
  process.exit(0);
}

console.log(
  `\nFAILED — ${problems.length} advisory(ies) at ${level}+ not accounted for, ` +
    `${stale.length} stale allowlist entry(ies).`,
);
process.exit(1);
