import { describe, expect, it } from 'vitest';
import { antiPhishingRequestSchema } from '../../../src/settings/antiPhishing/antiPhishing.dto';
import { ANTI_PHISHING } from '../../../src/settings/antiPhishing/antiPhishing.types';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * The anti-phishing code is compared BY EYE against something in an email, and the
 * user is told that a mismatch means fraud. So the input rule has one job beyond
 * bounding length: guarantee that the value's displayed form uniquely determines its
 * stored form. Anything that can render ambiguously — a homoglyph, a bidi override, a
 * zero-width character, collapsible whitespace — breaks that guarantee and with it the
 * comparison the whole feature rests on.
 *
 * Most of this file is therefore about what is REFUSED, and about the one decision that
 * looks like pedantry and is not: a value with surrounding whitespace is rejected
 * rather than trimmed.
 *
 * Bounds are read through `ANTI_PHISHING` rather than transcribed, so a founder
 * changing a number does not change this file.
 */

const valid = { action: 'set', code: 'Ada1815', emailCode: '123456' } as const;

const parse = (body: unknown) => antiPhishingRequestSchema.safeParse(body);

/** The `code` field's messages, for asserting WHICH rule refused a value. */
const codeIssues = (body: unknown): string[] => {
  const result = parse(body);
  if (result.success) return [];
  return result.error.issues.filter((i) => i.path[0] === 'code').map((i) => i.message);
};

describe('the code — length', () => {
  it('accepts the minimum length', () => {
    const code = 'A'.repeat(ANTI_PHISHING.MIN_LENGTH);

    expect(parse({ ...valid, code }).success).toBe(true);
  });

  it('accepts the maximum length', () => {
    const code = 'A'.repeat(ANTI_PHISHING.MAX_LENGTH);

    expect(parse({ ...valid, code }).success).toBe(true);
  });

  it('refuses one character below the minimum', () => {
    const code = 'A'.repeat(ANTI_PHISHING.MIN_LENGTH - 1);

    expect(parse({ ...valid, code }).success).toBe(false);
  });

  it('refuses one character above the maximum', () => {
    // The ceiling is about legibility at a glance in an email, not storage.
    const code = 'A'.repeat(ANTI_PHISHING.MAX_LENGTH + 1);

    expect(parse({ ...valid, code }).success).toBe(false);
  });

  it('refuses an empty string', () => {
    expect(parse({ ...valid, code: '' }).success).toBe(false);
  });

  it('reports BOTH failing rules at once, so one mistake costs one round trip', () => {
    // "ab cd" is too short AND has an illegal character. A caller fixing one and
    // resubmitting to discover the other is two exchanges for a single typo.
    const issues = codeIssues({ ...valid, code: 'ab cd' });

    expect(issues).toHaveLength(2);
  });
});

describe('the code — the alphabet', () => {
  it.each([
    ['upper case', 'ABCDEF'],
    ['lower case', 'abcdef'],
    ['digits', '123456'],
    ['mixed', 'Ada1815Lovelace'],
  ])('accepts %s', (_label, code) => {
    expect(parse({ ...valid, code }).success).toBe(true);
  });

  it.each([
    ['an interior space', 'Ada 1815'],
    ['a tab', 'Ada\t1815'],
    ['a newline', 'Ada\n1815'],
    ['a hyphen', 'Ada-1815'],
    ['an underscore', 'Ada_1815'],
    ['punctuation', 'Ada!1815'],
    ['an emoji', 'Ada1815🎉'],
    ['a Cyrillic homoglyph', 'Аda1815'],
    ['a zero-width space', 'Ada​1815'],
    ['a right-to-left override', 'Ada‮1815'],
    ['only whitespace', '      '],
  ])('refuses %s', (_label, code) => {
    expect(parse({ ...valid, code }).success).toBe(false);
  });

  it('refuses a Cyrillic homoglyph even though it renders identically to Latin', () => {
    // `А` (U+0410) and `A` (U+0041) are one glyph in most mail clients. Allowing both
    // would mean two different stored codes that a user cannot tell apart — so a forger
    // could substitute one and produce a code that LOOKS correct.
    expect(parse({ ...valid, code: 'Аda1815' }).success).toBe(false);
    expect(parse({ ...valid, code: 'Ada1815' }).success).toBe(true);
  });
});

describe('the code — whitespace is refused, not trimmed', () => {
  it.each([
    ['leading', ' Ada1815'],
    ['trailing', 'Ada1815 '],
    ['both', ' Ada1815 '],
  ])('refuses %s whitespace rather than silently trimming it', (_label, code) => {
    // ═══ THE DECISION THIS FILE EXISTS TO PIN ═══════════════════════════════
    //
    // Trimming would ACCEPT the request and store a value different from what the user
    // typed. For a password that is a kindness; for a value whose entire job is to be
    // compared character by character against an email, it is the input rule quietly
    // changing the thing being compared. So it is a refusal.
    expect(parse({ ...valid, code }).success).toBe(false);
  });

  it('does not mutate an accepted code in any way', () => {
    const result = parse({ ...valid, code: 'AbCd1234' });

    expect(result.success && result.data.code).toBe('AbCd1234');
  });
});

describe('the action discriminant', () => {
  it('accepts set with a code and an emailCode', () => {
    expect(parse({ action: 'set', code: 'Ada1815', emailCode: '123456' }).success).toBe(true);
  });

  it('accepts change with a currentCode', () => {
    expect(
      parse({ action: 'change', currentCode: 'Old1815', code: 'Ada1815', emailCode: '123456' })
        .success,
    ).toBe(true);
  });

  it('accepts replace without a currentCode', () => {
    expect(parse({ action: 'replace', code: 'Ada1815', emailCode: '123456' }).success).toBe(true);
  });

  it('refuses an unknown action', () => {
    expect(parse({ action: 'remove', code: 'Ada1815', emailCode: '123456' }).success).toBe(false);
  });

  it('refuses a missing action', () => {
    expect(parse({ code: 'Ada1815', emailCode: '123456' }).success).toBe(false);
  });

  it('requires an emailCode on every action', () => {
    // No operation is authorised without the mailbox. There is no member of the union
    // that omits it, which is what makes that structural rather than a service check.
    expect(parse({ action: 'set', code: 'Ada1815' }).success).toBe(false);
    expect(parse({ action: 'replace', code: 'Ada1815' }).success).toBe(false);
    expect(parse({ action: 'change', currentCode: 'Old1815', code: 'Ada1815' }).success).toBe(
      false,
    );
  });

  it('requires currentCode on change and refuses it elsewhere', () => {
    expect(parse({ action: 'change', code: 'Ada1815', emailCode: '123456' }).success).toBe(false);
    expect(
      parse({ action: 'set', currentCode: 'Old1815', code: 'Ada1815', emailCode: '123456' })
        .success,
    ).toBe(false);
  });

  it('does NOT apply the format rule to currentCode', () => {
    // A presented value is a guess at something already stored, and rejecting it on
    // composition would strand a user whose real code predates any future widening of
    // the alphabet — telling them their own code is invalid. It is bounded, not shaped.
    const result = parse({
      action: 'change',
      currentCode: 'old code with spaces!',
      code: 'Ada1815',
      emailCode: '123456',
    });

    expect(result.success).toBe(true);
  });
});

describe('.strict() — the anti-spoofing control', () => {
  it.each([
    ['configured', { configured: false }],
    ['userId', { userId: '01940000-0000-7000-8000-000000000009' }],
    ['otpVerified', { otpVerified: true }],
    ['securityRestriction', { securityRestriction: null }],
  ])('refuses a body carrying %s rather than stripping it', (_label, extra) => {
    // ═══ WHY THIS IS A SECURITY TEST AND NOT TIDINESS ═══════════════════════
    //
    // Zod strips unknown keys by default. Without `.strict()` these would vanish
    // silently and the request would SUCCEED — which looks to the caller as though the
    // server accepted their assertion about the account. The backend decides all four
    // of these; `.strict()` is what makes sending them an error instead of a no-op.
    expect(parse({ ...valid, ...extra }).success).toBe(false);
  });

  it('refuses a currentCode smuggled onto replace', () => {
    // Would otherwise be dropped, and the caller would believe a check ran.
    expect(
      parse({ action: 'replace', currentCode: 'Old1815', code: 'Ada1815', emailCode: '123456' })
        .success,
    ).toBe(false);
  });

  it('refuses a code field on no action at all', () => {
    expect(parse({}).success).toBe(false);
  });
});

describe('what the schema deliberately does not have', () => {
  it('has no confirmCode field', () => {
    // A mistyped anti-phishing code is self-correcting — it arrives in the user's next
    // email, where they see it and can change it. Unlike a password, there is nothing
    // to be locked out of, so a confirmation field would be friction guarding against a
    // mistake the feature reveals by itself.
    expect(parse({ ...valid, confirmCode: 'Ada1815' }).success).toBe(false);
  });

  it('has no remove action', () => {
    // Not an oversight. An account that has had a code and then has none teaches its
    // owner that a missing footer is normal, which is exactly the signal this feature
    // exists to make abnormal.
    expect(parse({ action: 'remove', emailCode: '123456' }).success).toBe(false);
  });
});
