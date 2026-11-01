import type { BlockedEmailKind } from '@prisma/client';

/**
 * The blocklist matching rules, as two pure functions.
 *
 * They are inverses and that is why they share a file. `classifyBlocklistValue`
 * decides the form a rule is STORED in; `blocklistCandidates` builds the set a
 * lookup is matched against. If the two ever disagree about normalisation — one
 * lowercases and the other does not, one strips a leading dot and the other does
 * not — the result is not a crash but something far worse: a rule that was
 * accepted, is visible in the table, and silently matches nothing. Keeping them
 * adjacent is what makes that divergence obvious in review.
 *
 * Both are sync and allocation-light on purpose: `blocklistCandidates` runs on
 * every signup and every login.
 */

/** The domain half of an address, normalised. Null when there isn't one. */
function domainOf(email: string): string | null {
  // `lastIndexOf`, not `indexOf`: a local-part may legally contain `@` when
  // quoted, and only the final one separates the domain.
  const at = email.lastIndexOf('@');
  if (at === -1) return null;

  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain === '' ? null : domain;
}

/**
 * Every blocklist value that would block `email`, cheapest match first.
 *
 * For `user@team.mailinator.com`:
 *
 *   user@team.mailinator.com   the EMAIL rule
 *   team.mailinator.com        a DOMAIN rule on the exact host
 *   mailinator.com             a DOMAIN rule on the parent, which is the one that
 *                              matters — temp-mail providers issue wildcard
 *                              subdomains, so blocking only the exact host would
 *                              be evaded by construction
 *
 * The walk stops before the final label, so a bare TLD is never a candidate. A
 * `com` row could otherwise lock out the entire internet, and the cost of that
 * mistake is too high to leave to whoever fills the table.
 */
export function blocklistCandidates(email: string): string[] {
  const address = email.trim().toLowerCase();
  const domain = domainOf(address);
  if (domain === null) return [];

  const candidates = [address];
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    candidates.push(labels.slice(i).join('.'));
  }
  return candidates;
}

/**
 * Normalise a rule for storage, and decide which kind it is.
 *
 * `kind` is derived here rather than supplied by the caller, so the column can
 * never contradict the value beside it. Returns null for anything that could not
 * match an address, which the write path drops: a stored rule that matches
 * nothing is worse than no rule, because it reads as protection.
 *
 * Accepts the shapes an operator actually types — `@mailinator.com`,
 * `*.mailinator.com`, `.mailinator.com`, `MailInator.com ` — and stores one
 * canonical form for all of them.
 */
export function classifyBlocklistValue(
  value: string,
): { kind: BlockedEmailKind; value: string } | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;

  const at = trimmed.lastIndexOf('@');

  // A leading `@` means "this domain", not an address with an empty local-part,
  // and it is how most people write a domain rule.
  if (at > 0) {
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    if (local === '' || !isDomain(domain)) return null;
    return { kind: 'EMAIL', value: trimmed };
  }

  const bare = trimmed.replace(/^[@*]?\.?/, '');
  return isDomain(bare) ? { kind: 'DOMAIN', value: bare } : null;
}

/**
 * At least two labels, each of them plausible.
 *
 * Two labels minimum is the same guard as the candidate walk's stop condition,
 * from the other side: a single-label rule could only ever be a TLD, and
 * `blocklistCandidates` would never offer one to match it against.
 */
function isDomain(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value);
}
