import type { Mail } from './mail.service';

/**
 * Email bodies. Pure functions returning both parts of a multipart message —
 * no I/O, no template engine, no filesystem reads at request time.
 *
 * Every value interpolated into the HTML goes through `escape` below. The codes
 * are generated server-side and the username is already restricted to
 * `[a-z0-9_]`, so today nothing here can carry markup — but "the input happens
 * to be safe" is not a property that survives the next field someone adds.
 */

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The end of the card, and the anchor `withAntiPhishingCode` appends before.
 *
 * A shared constant rather than a literal in each place, because the stamp works by
 * finding this exact text in an already-rendered body. As two separate literals they
 * could drift — an edit to `layout`'s closing markup would make the stamp's `replace`
 * match nothing, and the footer would silently disappear from the HTML part while still
 * appearing in the plaintext one. One constant makes that impossible: whatever this
 * becomes, both the writer and the finder use it.
 *
 * `withAntiPhishingCode` still refuses to guess if it is ever absent — see the note
 * there — but with this in place absence means the body did not come from `layout` at
 * all, rather than that somebody reformatted a closing tag.
 */
const CARD_CLOSE = `  </div>
</body></html>`;

function layout(heading: string, body: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1d21">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
    <p style="margin:0 0 24px;font-size:18px;font-weight:600;letter-spacing:-0.01em">OREBiT</p>
    <h1 style="margin:0 0 16px;font-size:20px;font-weight:600">${escape(heading)}</h1>
    ${body}
${CARD_CLOSE}`;
}

function codeBlock(code: string): string {
  return `<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:0.18em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escape(code)}</p>`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * An absolute instant, rendered for a reader.
 *
 * ─── Why this is hand-rolled and not `toLocaleString` ───────────────────────
 *
 * Three reasons, and the first is decisive. `toLocaleString` reads the SERVER's
 * locale and timezone, which are properties of whichever container happened to send
 * the message — so the same deadline could reach two recipients spelled two ways, or
 * change spelling after a deployment. An email is not rendered in the reader's
 * browser and cannot know their timezone, so the honest thing is one fixed form that
 * says which zone it is in.
 *
 * Second, it makes the string testable: a spec can assert the exact sentence without
 * pinning an ICU version. Third, this is the first formatted date in any template in
 * this service — `minutesUntil` in mail.service.ts is a relative count, not a date —
 * so there was no existing convention to follow and inventing the smallest one beats
 * pulling in a formatting dependency for a single line.
 *
 * UTC rather than a guess at the reader's zone. A deadline an hour off in the wrong
 * direction is worse than one the reader has to convert, and "UTC" in the string is
 * what makes the conversion possible at all.
 */
function formatInstant(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} ` +
    `at ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
  );
}

/**
 * ═══ THE ANTI-PHISHING FOOTER ═══════════════════════════════════════════════
 *
 * Stamp the account's anti-phishing code onto an already-rendered message.
 *
 * ─── Why this operates on a rendered MailBody rather than inside `layout` ───
 *
 * `layout` is the obvious hook — every template passes through it — and it is the wrong
 * one, because it renders the HTML part only. Each template builds its `text` string
 * independently, so a footer added to `layout` would be missing from the plaintext
 * alternative of every message: invisible to a text-only client, and invisible in the
 * console transport that developers read. A user told to look for a code and shown a
 * message without one would conclude the message was fake.
 *
 * Operating on the finished `MailBody` is what makes both parts a single decision.
 * `MailService.enqueue` is where it is applied, because that is the only funnel all
 * eight kinds pass through and the only place the `kind` and the body exist together.
 *
 * ─── Why the SUBJECT is deliberately untouched ──────────────────────────────
 *
 * `mail_deliveries.subject` is persisted to Postgres forever and indexed by
 * `(recipient, created_at)`, so a code in the subject line would durably store every
 * account's code in a table whose purpose is delivery diagnostics. The body is not
 * persisted there. It does transit Redis in the queue — rendered, like every message —
 * which is the same exposure the one-time codes already have and is bounded by the
 * queue's own lifetime.
 *
 * ─── Placement, and why it is last ──────────────────────────────────────────
 *
 * Appended at the end of both parts. A reader who has been taught to check it knows
 * where to look, and the position is identical on every message — which is the property
 * that makes checking it a habit rather than a search. It goes after the closing
 * paragraph of the body but INSIDE the card `layout` draws, so it reads as part of the
 * message rather than as a mail-client artefact.
 *
 * `escape` for the HTML part, as with every other interpolated value in this file. The
 * alphabet the code is restricted to cannot currently carry markup, but "the input
 * happens to be safe" is not a property that survives a future widening of that
 * alphabet — which is the reason this file gives for escaping everything.
 *
 * ─── Why a missing anchor throws rather than degrading ──────────────────────
 *
 * `CARD_CLOSE` is shared with `layout`, so the only way it can be absent is a body that
 * did not come from `layout`. Silently returning the message unstamped would ship an
 * email that omits a code the user has been told to check for, which is the one failure
 * this feature must not have quietly — so it throws, and `MailService.enqueue`'s caller
 * sees it. `MailService` already treats an enqueue failure as loud for the three
 * promise-returning sends and swallowed-but-logged for the notifications, so this
 * inherits a failure path that already exists rather than inventing one.
 */
export function withAntiPhishingCode(body: Mail, code: string): Mail {
  if (!body.html.includes(CARD_CLOSE)) {
    throw new Error('mail body does not end with the standard card; cannot stamp safely');
  }

  return {
    // `subject` is carried through untouched by the spread, and so is `auditSubject` —
    // stamping happens after rendering, so dropping the latter here would silently cost
    // every stamped message its code-free audit subject. Stated in the note above
    // rather than re-assigned, because assigning them to themselves would look like a
    // decision waiting to be changed.
    ...body,
    text:
      `${body.text}\n\n` +
      `--\n` +
      `Your anti-phishing code: ${code}\n` +
      `Every genuine OREBiT email shows this code. If an email claiming to be from ` +
      `OREBiT does not show it, or shows a different one, it is not from us.`,
    /**
     * ═══ A REPLACER FUNCTION, NOT A REPLACEMENT STRING ════════════════════════
     *
     * The arrow is the entire fix, and it is not a style preference. `String.replace`
     * interprets `$` sequences in a replacement STRING — `$&` becomes the matched text,
     * `` $` `` the text before it, `$'` the text after, `$$` a single `$` — and the code
     * is interpolated into that string. A replacement FUNCTION's return value is
     * inserted verbatim, with no such pass.
     *
     * ─── Why `escape` did not already cover this, and made it worse ───────────
     *
     * `escape` handles markup, not replacement syntax; `$` is not one of the five
     * characters it touches. Worse, four of the five it DOES touch become entities
     * beginning with `&` — so it manufactures the dangerous sequence out of inputs that
     * did not contain it. `$<name>` escapes to `$&lt;name&gt;`, and `$'` to `$&#39;`:
     * both now start `$&`, and both expanded to a copy of the card's closing markup.
     *
     * ─── Why this is worth fixing while it is unreachable ─────────────────────
     *
     * `ANTI_PHISHING_PATTERN` is `/^[A-Za-z0-9]+$/`, so no stored code can contain a
     * `$` today and none of this is currently exploitable. It is fixed anyway because
     * the alphabet is documented as a product decision rather than a technical limit —
     * `antiPhishing.types.ts` says widening it is "this constant plus a
     * confusable-normalisation policy, not a migration". The day somebody widens it,
     * nothing would connect that one-line change to an email body that echoes its own
     * markup back at the reader, in the one message whose whole purpose is to be
     * recognisable.
     */
    html: body.html.replace(
      CARD_CLOSE,
      () => `    <hr style="margin:24px 0 16px;border:0;border-top:1px solid #e5e7eb">
    <p style="margin:0 0 4px;font-size:12px;line-height:1.5;color:#6b7280">Your anti-phishing code</p>
    <p style="margin:0 0 8px;font-size:16px;font-weight:700;letter-spacing:0.08em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escape(code)}</p>
    <p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280">Every genuine OREBiT email shows this code. If an email claiming to be from OREBiT does not show it, or shows a different one, it is not from us.</p>
${CARD_CLOSE}`,
    ),
  };
}

/**
 * ═══ THE TWO TEMPLATES WHOSE SUBJECT CARRIES THE CODE ═══════════════════════
 *
 * `otpEmail` and `passwordResetEmail` lead their subject with the live code, and that
 * stays. It is a real usability property: a reader scanning an inbox, or a phone
 * showing a notification, gets the digits without opening the message.
 *
 * What they now also carry is `auditSubject` — the same sentence with the code lifted
 * out, for the row `mail_deliveries` keeps forever. The reasoning is on
 * `MailBody.auditSubject`, and the persistence boundary does not depend on either of
 * these two remembering: see `safeAuditSubject`.
 */
export function otpEmail(to: string, code: string, minutesValid: number): Mail {
  return {
    to,
    subject: `${code} is your OREBiT verification code`,
    auditSubject: 'Your OREBiT verification code',
    text: `Your OREBiT verification code is ${code}.\n\nIt expires in ${minutesValid} minutes. If you did not request it, you can ignore this email.`,
    html: layout(
      'Verify your email address',
      `${codeBlock(code)}
       <p style="margin:0 0 8px;font-size:14px;line-height:1.5">This code expires in ${minutesValid} minutes.</p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280">If you did not request it, you can ignore this email.</p>`,
    ),
  };
}

export function passwordResetEmail(to: string, code: string, minutesValid: number): Mail {
  return {
    to,
    subject: `${code} is your OREBiT password reset code`,
    auditSubject: 'Your OREBiT password reset code',
    text: `Use ${code} to reset your OREBiT password.\n\nIt expires in ${minutesValid} minutes. If you did not request a reset, ignore this email — your password has not changed.`,
    html: layout(
      'Reset your password',
      `${codeBlock(code)}
       <p style="margin:0 0 8px;font-size:14px;line-height:1.5">This code expires in ${minutesValid} minutes.</p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280">If you did not request a reset, ignore this email — your password has not changed.</p>`,
    ),
  };
}

export function welcomeEmail(to: string, username: string, publicCode: string): Mail {
  return {
    to,
    subject: 'Welcome to OREBiT',
    text: `Your OREBiT account is ready.\n\nUsername: ${username}\nUser ID: ${publicCode}\n\nYou can sign in with your email, your username, or your user ID.`,
    html: layout(
      'Your account is ready',
      `<p style="margin:0 0 16px;font-size:14px;line-height:1.5">Username: <strong>${escape(username)}</strong><br>
        User ID: <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escape(publicCode)}</strong></p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280">You can sign in with your email, your username, or your user ID.</p>`,
    ),
  };
}

/**
 * "Something changed on your account" — gap M3.
 *
 * The security value is entirely in the case where the recipient did NOT do it.
 * That is why it names what changed and roughly where from, and why it says the
 * other sessions were ended: a reader who did not do this needs to know both that
 * it happened and that whoever did it is no longer signed in.
 *
 * The location is an IP class, not an address — a /24 is enough for "not where I
 * live" and does not put a precise address in an inbox.
 */
export function securityChangedEmail(to: string, what: string, ipClass: string): Mail {
  return {
    to,
    subject: `Your OREBiT ${what}`,
    text:
      `Your OREBiT ${what}, from network ${ipClass}.\n\n` +
      `Every other signed-in device has been signed out.\n\n` +
      `If this was not you, someone has access to your account: sign in and change your password immediately.`,
    html: layout(
      `Your ${escape(what)}`,
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">From network <strong>${escape(ipClass)}</strong>.</p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.5">Every other signed-in device has been signed out.</p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280">If this was not you, someone has access to your account — sign in and change your password immediately.</p>`,
    ),
  };
}

/**
 * "Your social login is scheduled to be removed."
 *
 * ─── Why this is not `securityChangedEmail` with a different `what` ─────────
 *
 * Because that template states two things that are both FALSE here. It says the
 * change has happened, and this one has not — the provider still signs the reader in.
 * And it says every other device was signed out, which no unlink does. Reusing it
 * would have produced a message that misdescribes the account's actual state, which
 * is the one failure a security notification cannot afford.
 *
 * The whole point of the seven-day delay is that a reader who did NOT do this has
 * time to act, so the message leads with the date and says plainly that nothing has
 * been removed yet. A reader who did do it needs one sentence; a reader who did not
 * needs to know exactly how long they have.
 *
 * There is no cancellation link, because there is no cancellation endpoint. What the
 * reader can do instead is real and is stated: sign in and re-link the same provider
 * account, which takes the request back. Inventing a "this wasn't me" button for a
 * flow that does not exist would be worse than saying what actually works.
 *
 * Carries the provider NAME and nothing else about the link — no subject, no provider
 * account id, no address asserted by the provider. Naming which provider is the
 * information the reader needs; identifying the far-side account is not.
 */
export function socialUnlinkScheduledEmail(
  to: string,
  provider: string,
  unlinkAt: Date,
  ipClass: string,
): Mail {
  const when = formatInstant(unlinkAt);

  return {
    to,
    subject: `Your OREBiT ${provider} sign-in is scheduled to be removed`,
    text:
      `Someone asked to remove ${provider} sign-in from your OREBiT account, from network ${ipClass}.\n\n` +
      `This has NOT happened yet. Your ${provider} account stays linked and you can keep signing in with it until ${when}, when it will be removed.\n\n` +
      `If you asked for this, no action is needed.\n\n` +
      `If you did NOT ask for this, sign in and link the same ${provider} account again — that cancels the removal. ` +
      `Then change your password, because somebody else could reach your account.`,
    html: layout(
      `Your ${escape(provider)} sign-in is scheduled to be removed`,
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">Someone asked to remove <strong>${escape(provider)}</strong> sign-in from your OREBiT account, from network <strong>${escape(ipClass)}</strong>.</p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.5"><strong>This has not happened yet.</strong> Your ${escape(provider)} account stays linked, and you can keep signing in with it until <strong>${escape(when)}</strong>.</p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.5">If you asked for this, no action is needed.</p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280"><strong>If you did not ask for this</strong>, sign in and link the same ${escape(provider)} account again — that cancels the removal. Then change your password, because somebody else could reach your account.</p>`,
    ),
  };
}

/**
 * ═══ THE ACCOUNT-DELETION NOTIFICATIONS ═════════════════════════════════════
 *
 * Three messages, and the first two are shaped by the same fact: unlike the social
 * unlink above, a deletion takes effect IMMEDIATELY. The reader who did not ask for
 * this is already locked out by the time they open the message, so "if this wasn't you,
 * sign in and undo it" — the advice the unlink mail gives — is advice they cannot take.
 *
 * So these lead with the deadline and with the one route back that still works: the
 * reactivation flow, which needs only the mailbox this message just arrived in. That is
 * deliberate and is the reason the flow is public.
 */

/**
 * The account was deleted. Sent immediately, to the address it belonged to.
 *
 * Not perishable, for `socialUnlinkScheduledEmail`'s reason and more strongly: this
 * message is the reader's only notice that they have thirty days to act, and dropping
 * a retry past some expiry would drop it for precisely the reader who needs it. It
 * carries no code, so there is nothing in it to go stale.
 *
 * Says plainly that the data is not gone yet, because the reader's decision depends on
 * it — "your account was deleted" invites someone who did not do it to assume it is
 * hopeless and stop reading.
 */
export function accountDeletedEmail(to: string, purgeAt: Date, ipClass: string): Mail {
  const when = formatInstant(purgeAt);

  return {
    to,
    subject: 'Your OREBiT account has been deleted',
    text:
      `Your OREBiT account was deleted from network ${ipClass}, and you have been signed out everywhere.\n\n` +
      `Your data has NOT been erased yet. You can restore the account until ${when}. After that it is permanent and cannot be undone.\n\n` +
      `If you asked for this, no action is needed — you can ignore this message.\n\n` +
      `If you did NOT ask for this, restore your account now: go to OREBiT, choose "Restore a deleted account", and enter this email address. ` +
      `We will email you a code. You do not need your password. Once you are back in, change your password immediately, because somebody else could reach your account.`,
    html: layout(
      'Your account has been deleted',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">Your OREBiT account was deleted from network <strong>${escape(ipClass)}</strong>, and you have been signed out everywhere.</p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.5"><strong>Your data has not been erased yet.</strong> You can restore the account until <strong>${escape(when)}</strong>. After that it is permanent and cannot be undone.</p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.5">If you asked for this, no action is needed.</p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280"><strong>If you did not ask for this</strong>, restore your account now — choose &ldquo;Restore a deleted account&rdquo; and enter this email address. We will email you a code, and you will not need your password. Once you are back in, change your password immediately.</p>`,
    ),
  };
}

/**
 * The code that restores a deleted account.
 *
 * PERISHABLE, unlike the other two: it is a one-time code and is worthless once it
 * lapses, so a delivery retried past the expiry should be dropped rather than
 * delivered. That is the same treatment `otpEmail` gets, and for the same reason.
 *
 * Names no account detail — not the username, not the public code, not when the
 * deletion happened. This message is sent in response to an unauthenticated request
 * naming only an address, so everything it contains is something the requester supplied
 * or already knows. A restore code mail that confirmed the username would turn the
 * public reactivation route into a lookup service.
 */
export function accountReactivationEmail(to: string, code: string, minutesValid: number): Mail {
  return {
    to,
    subject: 'Restore your OREBiT account',
    text:
      `Your OREBiT account restore code is ${code}. It expires in ${minutesValid} minutes.\n\n` +
      `If you did not ask to restore an account, ignore this message. Nothing has changed and no account was named.`,
    html: layout(
      'Restore your account',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">Your account restore code is:</p>
       <p style="margin:0 0 16px;font-size:28px;letter-spacing:4px;font-weight:600">${escape(code)}</p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.5">It expires in ${minutesValid} minutes.</p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280">If you did not ask to restore an account, ignore this message. Nothing has changed.</p>`,
    ),
  };
}

/**
 * The account is live again.
 *
 * The closing half of the pair: somebody who receives the deletion notice and acts on
 * it should get confirmation that it worked, and somebody who receives THIS without
 * having asked has learned that an attacker holds their mailbox — which is a more
 * urgent fact than the reactivation itself, and is why the message says to change the
 * password rather than merely welcoming them back.
 */
export function accountReactivatedEmail(to: string, ipClass: string): Mail {
  return {
    to,
    subject: 'Your OREBiT account has been restored',
    text:
      `Your OREBiT account was restored from network ${ipClass}. It will no longer be deleted, and you can sign in again.\n\n` +
      `You will need to sign in — restoring the account does not bring back the sessions it had.\n\n` +
      `If you did NOT do this, somebody else can read your email. Change your password and your email password now.`,
    html: layout(
      'Your account has been restored',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">Your OREBiT account was restored from network <strong>${escape(ipClass)}</strong>. It will no longer be deleted.</p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.5">You will need to sign in again — restoring the account does not bring back the sessions it had.</p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280"><strong>If you did not do this</strong>, somebody else can read your email. Change your password and your email password now.</p>`,
    ),
  };
}

/**
 * ═══ THE EMAIL-CHANGE NOTIFICATIONS ═════════════════════════════════════════
 *
 * Three messages, and one of them is not really a notification at all.
 *
 * `emailChangedEmail` goes to the address the account just LEFT, and it carries the
 * recovery link. That makes it the only message in this file whose delivery is
 * load-bearing rather than informational: it is the mechanism by which somebody whose
 * account was taken over gets it back. Everything else here tells a reader what
 * happened; this one hands them the means to undo it.
 *
 * Which is why it leads with the question rather than the fact. "Your email was
 * changed" invites a reader who did it to stop reading; "did you do this?" is the
 * prompt that gets the other reader to act.
 *
 * The new address is shown MASKED. The recipient of this message is, in the bad case,
 * an attacker's victim — but in the other bad case the recipient is a mailbox the
 * account no longer controls, and printing the account's new address in full there
 * would hand a stranger the exact identifier they need to keep attacking it.
 */
export function emailChangedEmail(
  to: string,
  maskedNewEmail: string,
  recoveryUrl: string,
  ipClass: string,
): Mail {
  return {
    to,
    subject: 'Your OREBiT email address was changed — did you do this?',
    text:
      `The email address on your OREBiT account was changed to ${maskedNewEmail}, from network ${ipClass}.\n\n` +
      `If you did this, no action is needed.\n\n` +
      `If you did NOT do this, someone else has access to your account. Use the link below to take it back — ` +
      `you can restore this address, or move the account to a different one:\n\n${recoveryUrl}\n\n` +
      `This link works for a limited time and can only be used once.`,
    html: layout(
      'Did you change your email address?',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">The email address on your OREBiT account was changed to <strong>${escape(maskedNewEmail)}</strong>, from network <strong>${escape(ipClass)}</strong>.</p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.5">If you did this, no action is needed.</p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.5"><strong>If you did not do this</strong>, someone else has access to your account. Take it back — you can restore this address, or move the account to a different one:</p>
       <p style="margin:0 0 16px"><a href="${escape(recoveryUrl)}" style="display:inline-block;padding:12px 20px;background:#1a1d21;color:#fff;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none">This wasn't me</a></p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280">This link works for a limited time and can only be used once.</p>`,
    ),
  };
}

/** Goes to the address that just became the account's. Purely informational — the
 *  recipient has already proved they hold this mailbox by completing the change. */
export function emailAddedEmail(to: string, ipClass: string): Mail {
  return {
    to,
    subject: 'This is now your OREBiT email address',
    text:
      `This address is now the email address on your OREBiT account, changed from network ${ipClass}.\n\n` +
      `Every other signed-in device has been signed out.\n\n` +
      `If you did not expect this, contact support immediately.`,
    html: layout(
      'This is now your OREBiT email address',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">Changed from network <strong>${escape(ipClass)}</strong>.</p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.5">Every other signed-in device has been signed out.</p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280">If you did not expect this, contact support immediately.</p>`,
    ),
  };
}

/**
 * Goes to the address a recovery just REMOVED from the account.
 *
 * In the compromise case this is the attacker's own mailbox, which is the reason it
 * says as little as it does: it confirms the address is no longer attached and names
 * nothing about the account it was attached to.
 */
export function emailRemovedEmail(to: string, ipClass: string): Mail {
  return {
    to,
    subject: 'This address is no longer on an OREBiT account',
    text:
      `This email address has been removed from an OREBiT account, from network ${ipClass}.\n\n` +
      `No further action is available from this address.`,
    html: layout(
      'This address was removed',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">This email address has been removed from an OREBiT account, from network <strong>${escape(ipClass)}</strong>.</p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280">No further action is available from this address.</p>`,
    ),
  };
}

/**
 * "New sign-in from a device we have not seen" — gap M4.
 *
 * Sent on a first sign-in from an unrecognised browser, and like
 * `securityChangedEmail` its whole value is in the case where the reader did not
 * do it. That is why it leads with what and where rather than with reassurance.
 *
 * Deliberately NOT sent on every sign-in. A notification that arrives constantly
 * is one nobody reads, and the point of this one is that it is unusual.
 */
export function newDeviceLoginEmail(to: string, device: string, ipClass: string): Mail {
  return {
    to,
    subject: 'New sign-in to your OREBiT account',
    text:
      `Your OREBiT account was signed in to from a new device.\n\n` +
      `Device: ${device}\nNetwork: ${ipClass}\n\n` +
      `If this was you, nothing to do. If it was not, change your password and sign out other devices from your account settings.`,
    html: layout(
      'New sign-in',
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.5">Device: <strong>${escape(device)}</strong><br>
        Network: <strong>${escape(ipClass)}</strong></p>
       <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280">If this was you, nothing to do. If it was not, change your password and sign out other devices from your account settings.</p>`,
    ),
  };
}
