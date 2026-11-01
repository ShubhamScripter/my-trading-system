# Email blocklist

Temp-mail and abuse control. One table, `identity.blocked_emails`, read on every
signup and every signin. A row is a rule; no row means the address goes through.

## What a row means

| `kind` | `value` | Matches |
|---|---|---|
| `DOMAIN` | `mailinator.com` | `any@mailinator.com`, and `any@team.mailinator.com` — the domain **and everything under it** |
| `EMAIL` | `someone@gmail.com` | that one address, nothing else |

`kind` is derived from `value` when the row is written, so the two cannot
disagree. Operators may type `mailinator.com`, `@mailinator.com`,
`*.mailinator.com` or `.mailinator.com`; all four store as the same `DOMAIN` rule.

Two rules are enforced on write, and both drop the value rather than storing it:

- **A single label is refused.** `com` would lock out the entire internet, and a
  bare TLD is never even offered as a match candidate.
- **A value that could not match an address is refused.** A rule that matches
  nothing is worse than no rule, because it reads as protection.

## Where it is enforced

| Door | Behaviour |
|---|---|
| `POST /auth/register` `step: start` | `400 email_domain_blocked` |
| `POST /auth/login` `mode: password` | `400 email_domain_blocked` |
| `POST /auth/login` `mode: otp-verify` | `400 email_domain_blocked` |
| `POST /auth/login` `mode: otp-request` | **Silent** — no code is sent, and the response is identical to an unknown account |
| `POST /auth/login` `mode: oauth-callback` | `400 email_domain_blocked`, for both an existing link and a new identity |
| `POST /auth/login` `mode: oauth-register` | `400 email_domain_blocked` |

Three details that are deliberate and easy to undo by accident:

- **Login checks the account's email, not the identifier typed.** Signing in by
  username or public code resolves to an account first, and that account's
  address is what is checked — otherwise a blocked user would simply log in by
  username.
- **`otp-request` never throws.** That endpoint answers identically whether or not
  it sent a code, which is what stops it disclosing which addresses have accounts.
  Blocking is folded into its eligibility check, not asserted.
- **Blocking an existing user's domain locks them out.** This is a live control,
  not a signup filter. It is a different lever from `UserStatus.DISABLED`, which
  targets one account.

The refusal never names the rule that matched. `reason` is for whoever reads the
table later; telling a caller which pattern caught them is a free oracle for
finding one that does not.

## Managing rules

There is **no admin API yet**. Until there is, rules are managed directly:

```sql
-- Block a domain and everything under it.
INSERT INTO identity.blocked_emails (id, kind, value, reason)
VALUES (gen_random_uuid(), 'DOMAIN', 'newtempmail.example', 'abuse wave 2026-08');

-- Block one address.
INSERT INTO identity.blocked_emails (id, kind, value, reason)
VALUES (gen_random_uuid(), 'EMAIL', 'someone@gmail.com', 'fraud');

-- Unblock.
DELETE FROM identity.blocked_emails WHERE value = 'newtempmail.example';
```

`value` must already be normalised — lowercased, and no `@` on a `DOMAIN` row.
Going through `BlocklistDbOperation.blockMany` normalises for you and is what the
admin route should call when it lands. `created_by` exists for that route to fill
in; seeded rows leave it null.

Changes take effect on the next request. There is no cache to bust — see the
comment in `auth/services/blocklist.service.ts` for why that is a deliberate
choice rather than an oversight.

## Seeding

`npm run db:seed` loads 8,359 known disposable domains from
`src/utils/disposable-email.ts`, a one-time copy of the
[`disposable-email-domains`](https://github.com/disposable-email-domains/disposable-email-domains)
blocklist.

The seed is additive and idempotent: re-running inserts only what is missing and
never overwrites an existing row, so hand-added rules and edited reasons survive.
Refresh the list by regenerating that array in a standalone PR, then re-seeding.

Editing `src/utils/disposable-email.ts` does **not** block anything on its own —
it is seed data, not a runtime check. The table is the authority.
