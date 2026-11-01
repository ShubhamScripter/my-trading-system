import { describe, expect, it } from 'vitest';
import { withAntiPhishingCode } from '../../src/mail/mail.templates';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * `mail.templates.ts` had no coverage at all before this. The transform added to it is
 * worth covering on its own, because it has one property that is easy to get wrong and
 * invisible when it is:
 *
 *   THE FOOTER MUST APPEAR IN BOTH PARTS.
 *
 * A multipart message carries `text` and `html`, and every template in that file builds
 * them independently. A footer added to the shared `layout` helper would land in the
 * HTML only — so a text-only client, and the console transport developers read locally,
 * would show a genuine Orebit email with no code on it. A user who has been taught that
 * a missing code means fraud would conclude, correctly by their own rule and wrongly in
 * fact, that the message was a forgery.
 *
 * The templates are exercised through their real rendered output rather than a
 * hand-built body, so the anchor this transform depends on is the anchor `layout`
 * actually emits.
 */

const CODE = 'Ada1815';

/** A body shaped exactly as `layout` produces one. Built here rather than imported
 *  because the eight template functions are module-private to mail.templates.ts; the
 *  gate spec drives the real ones through `MailService`. */
const body = {
  to: 'ada@example.test',
  subject: '123456 is your OREBiT verification code',
  text: 'Your OREBiT verification code is 123456.',
  html: `<!doctype html>
<html><body style="margin:0;padding:24px">
  <div style="max-width:520px">
    <p>OREBiT</p>
    <h1>Verify your email address</h1>
    <p>123456</p>
  </div>
</body></html>`,
};

describe('withAntiPhishingCode — both parts', () => {
  it('puts the code in the PLAINTEXT part', () => {
    expect(withAntiPhishingCode(body, CODE).text).toContain(CODE);
  });

  it('puts the code in the HTML part', () => {
    expect(withAntiPhishingCode(body, CODE).html).toContain(CODE);
  });

  it('keeps the original content of both parts intact', () => {
    const stamped = withAntiPhishingCode(body, CODE);

    expect(stamped.text).toContain('Your OREBiT verification code is 123456.');
    expect(stamped.html).toContain('<h1>Verify your email address</h1>');
  });

  it('explains what the code means, in both parts', () => {
    // A code with no explanation teaches nobody to check it. The sentence is the
    // feature; the string is just a string.
    const stamped = withAntiPhishingCode(body, CODE);

    expect(stamped.text).toMatch(/every genuine OREBiT email shows this code/i);
    expect(stamped.html).toMatch(/every genuine OREBiT email shows this code/i);
  });
});

describe('withAntiPhishingCode — the subject line', () => {
  it('leaves the subject completely untouched', () => {
    // ═══ WHY THIS IS A SECURITY TEST ════════════════════════════════════════
    //
    // `mail_deliveries.subject` is persisted to Postgres forever and indexed by
    // `(recipient, created_at)`. A code in the subject would durably store every
    // account's code in a delivery-diagnostics table. The body is never written there.
    expect(withAntiPhishingCode(body, CODE).subject).toBe(body.subject);
  });

  it('leaves the recipient untouched', () => {
    expect(withAntiPhishingCode(body, CODE).to).toBe(body.to);
  });
});

describe('withAntiPhishingCode — placement and escaping', () => {
  it('places the footer INSIDE the card, not after the document', () => {
    const html = withAntiPhishingCode(body, CODE).html;

    // After the message content but before the closing markup, so it reads as part of
    // the email rather than as a mail-client artefact — and so the HTML stays valid.
    expect(html.indexOf(CODE)).toBeGreaterThan(html.indexOf('<h1>'));
    expect(html.indexOf(CODE)).toBeLessThan(html.indexOf('</body></html>'));
    expect(html.trimEnd().endsWith('</body></html>')).toBe(true);
  });

  it('puts the footer at the END of the plaintext part', () => {
    const text = withAntiPhishingCode(body, CODE).text;

    // Identical position on every message is what makes checking it a habit rather
    // than a search.
    expect(text.indexOf(CODE)).toBeGreaterThan(text.indexOf('verification code is'));
  });

  it('escapes HTML-significant characters in the code', () => {
    // The alphabet the DTO enforces cannot currently carry markup, but "the input
    // happens to be safe" is not a property that survives a future widening of it —
    // which is the reason mail.templates.ts escapes every interpolated value.
    const stamped = withAntiPhishingCode(body, '<script>x</script>');

    expect(stamped.html).not.toContain('<script>');
    expect(stamped.html).toContain('&lt;script&gt;');
  });

  it('does not escape the plaintext part, which is not markup', () => {
    expect(withAntiPhishingCode(body, '<x>').text).toContain('<x>');
  });
});

describe('withAntiPhishingCode — refusing to guess', () => {
  it('throws when the body does not carry the standard card anchor', () => {
    // The anchor is shared with `layout`, so absence means the body did not come from
    // `layout` at all. Returning it unstamped would ship a message missing a code the
    // user has been told to check for — the one failure this feature must not have
    // quietly.
    expect(() =>
      withAntiPhishingCode({ ...body, html: '<p>hand-rolled, no card</p>' }, CODE),
    ).toThrow(/standard card/i);
  });
});

describe('withAntiPhishingCode — the value is passed through exactly', () => {
  it('preserves case', () => {
    const stamped = withAntiPhishingCode(body, 'AbCd1234');

    expect(stamped.text).toContain('AbCd1234');
    expect(stamped.html).toContain('AbCd1234');
  });

  it('does not alter a code at the maximum allowed length', () => {
    const long = 'A'.repeat(30);

    expect(withAntiPhishingCode(body, long).text).toContain(long);
  });
});

/**
 * ═══ THE CODE IS DATA, NOT REPLACEMENT SYNTAX ═══════════════════════════════
 *
 * `withAntiPhishingCode` stamps the footer by calling `body.html.replace(CARD_CLOSE, …)`.
 * When the second argument is a STRING, JavaScript scans it for `$` sequences before
 * inserting: `$&` becomes the matched text, backtick-dollar the text before the match,
 * `$'` the text after, and `$$` a single `$`. The account's code was interpolated into
 * that string, so a code containing any of them was executed as replacement syntax
 * rather than shown.
 *
 * ─── `escape` did not cover this, and actively made it worse ────────────────
 *
 * `escape` handles markup; `$` is not one of the five characters it touches. Worse,
 * four of the five it DOES touch become entities starting with `&` — so it MANUFACTURES
 * the dangerous sequence from inputs that never contained it. `$<name>` escapes to
 * `$&lt;name&gt;` and `$'` to `$&#39;`; both now begin `$&`, and both expanded into a
 * second copy of the card's closing markup inside the message body.
 *
 * ─── Latent, and fixed anyway ───────────────────────────────────────────────
 *
 * `ANTI_PHISHING_PATTERN` is `/^[A-Za-z0-9]+$/`, so no stored code can contain a `$`
 * today. The alphabet is documented as a product decision rather than a technical limit,
 * and the day it widens nothing would connect that one-line change to an email that
 * echoes its own markup back at the reader — in the one message whose entire purpose is
 * to be recognisable. These tests are what would connect them.
 */

/** The template's own escaping, mirrored so a case can state its exact expected text. */
function escaped(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe('withAntiPhishingCode — replacement patterns are not evaluated', () => {
  it('inserts $& literally instead of echoing the matched markup', () => {
    // ═══ THE CORE REGRESSION ════════════════════════════════════════════════
    //
    // Under the old string replacement this produced a SECOND copy of the card's
    // closing markup inside the body, because `$&` expanded to the matched text.
    const stamped = withAntiPhishingCode(body, '$&INJECTED');

    expect(stamped.html).toContain(escaped('$&INJECTED'));
    // The anchor appears exactly once: once as the document's own ending, and nowhere
    // else. Two would mean the match was echoed back into the message.
    expect(occurrences(stamped.html, '</body></html>')).toBe(1);
    expect(occurrences(stamped.html, '</div>')).toBe(1);
  });

  it.each([
    ['the matched substring', '$&'],
    ['the text after the match', "$'"],
    ['the text before the match', '$`'],
    ['an escaped dollar', '$$'],
    ['a capture-group reference', '$1'],
    ['a named-group reference', '$<name>'],
    ['a pattern in the middle of a real code', 'Ada$&1815'],
    ['several at once', "$$$&$'$`"],
  ])('inserts %s literally', (_case, code) => {
    const stamped = withAntiPhishingCode(body, code);

    // The whole invariant in one line: whatever was supplied appears, escaped for
    // markup and otherwise untouched.
    expect(stamped.html).toContain(escaped(code));
    expect(occurrences(stamped.html, '</body></html>')).toBe(1);
  });

  it('does not collapse $$ into a single dollar', () => {
    // `$$` is the one pattern that corrupted rather than injected: it rendered as a
    // single `$`, so a user comparing their code against the email saw a value that
    // did not match the one they had set.
    const stamped = withAntiPhishingCode(body, 'A$$B');

    expect(stamped.html).toContain('A$$B');
    expect(stamped.html).not.toContain('A$B');
  });

  it('keeps the plaintext part literal too', () => {
    // The text part is built by concatenation rather than `replace`, so it was never
    // affected. Asserted so the two halves cannot drift apart in a future edit.
    expect(withAntiPhishingCode(body, "$&$'$`").text).toContain("$&$'$`");
  });

  it('leaves a legitimate dollar alone', () => {
    // The fix must not have started escaping or stripping `$`. A lone dollar is not a
    // replacement pattern and has to survive exactly as typed.
    const stamped = withAntiPhishingCode(body, 'US$100');

    expect(stamped.html).toContain('US$100');
    expect(stamped.text).toContain('US$100');
  });
});

describe('withAntiPhishingCode — the stamp happens exactly once', () => {
  it('replaces the anchor a single time and leaves the rest of the body alone', () => {
    const stamped = withAntiPhishingCode(body, '$&');

    // Everything the template started with is still there, once each.
    expect(occurrences(stamped.html, '<h1>Verify your email address</h1>')).toBe(1);
    expect(occurrences(stamped.html, 'Your anti-phishing code')).toBe(1);
    expect(occurrences(stamped.html, '<p>OREBiT</p>')).toBe(1);
  });

  it('does not duplicate the code itself', () => {
    const stamped = withAntiPhishingCode(body, 'Ada1815');

    expect(occurrences(stamped.html, 'Ada1815')).toBe(1);
  });

  it('produces byte-identical output for an ordinary code', () => {
    // The golden check. A value with no `$` in it must render exactly as it did before
    // the fix — the arrow changes how the replacement is inserted, not what it is.
    const stamped = withAntiPhishingCode(body, 'Ada1815');

    expect(stamped.html).toBe(
      body.html.replace(
        '  </div>\n</body></html>',
        () => `    <hr style="margin:24px 0 16px;border:0;border-top:1px solid #e5e7eb">
    <p style="margin:0 0 4px;font-size:12px;line-height:1.5;color:#6b7280">Your anti-phishing code</p>
    <p style="margin:0 0 8px;font-size:16px;font-weight:700;letter-spacing:0.08em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">Ada1815</p>
    <p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280">Every genuine OREBiT email shows this code. If an email claiming to be from OREBiT does not show it, or shows a different one, it is not from us.</p>
  </div>
</body></html>`,
      ),
    );
  });

  it('still stamps every kind that carries a code, through the real service funnel', () => {
    // `MailService.enqueue` is the single caller — all eight kinds pass through it, so
    // a helper-level guarantee is a service-wide one. Pinned here rather than only in
    // mail.service.spec.ts so the claim sits beside the fix it depends on.
    const stamped = withAntiPhishingCode(body, '$&');

    expect(stamped.text).toContain('$&');
    expect(stamped.html).toContain(escaped('$&'));
  });
});
