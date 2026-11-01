import { describe, expect, it } from 'vitest';
import { USERNAME } from '../../../auth/auth.constants';
import {
  assessUsername,
  complianceCandidate,
  isProtectedReservation,
  lengthBandFor,
  normaliseUsername,
  suggestionCandidates,
} from '../../../src/settings/username/username.utility';

/**
 * The pure rules. Every one of these runs at least twice in production — once where a
 * refusal is cheap and once where it is authoritative — so they are tested here as
 * functions rather than through the service that calls them.
 */

const FREE = lengthBandFor(false);
const PREMIUM = lengthBandFor(true);

const codes = (username: string, band = FREE): string[] => {
  const verdict = assessUsername(username, band);
  return verdict.ok ? [] : verdict.issues.map((issue) => issue.code);
};

describe('normaliseUsername — one function, used by every layer', () => {
  it('folds case, so uniqueness cannot be defeated by capitalisation', () => {
    expect(normaliseUsername('Shubh')).toBe('shubh');
    expect(normaliseUsername('SHUBH')).toBe('shubh');
    expect(normaliseUsername('sHuBh')).toBe('shubh');
  });

  it('strips surrounding whitespace, including the kinds a paste introduces', () => {
    expect(normaliseUsername('  shubh  ')).toBe('shubh');
    expect(normaliseUsername('\tshubh\n')).toBe('shubh');
  });

  it('folds compatibility forms onto ASCII, closing the lookalike hole', () => {
    // Fullwidth Latin. Without NFKC these are distinct code points that render almost
    // identically, so `ａdmin` would sail past both the reserved list and an existing
    // account.
    expect(normaliseUsername('ａｄｍｉｎ')).toBe('admin');
    // A ligature, which decomposes under compatibility folding.
    expect(normaliseUsername('ﬁnance')).toBe('finance');
  });

  it('leaves characters it cannot fold for the charset check to refuse', () => {
    // Cyrillic а (U+0430) is not a compatibility variant of Latin a, so no
    // normalisation form will fold it. This is exactly why the charset is ASCII-only:
    // the rule refuses it rather than pretending to fold it.
    const cyrillic = normaliseUsername('shubhа');
    expect(cyrillic).toBe('shubhа');
    expect(codes(cyrillic)).toContain('charset');
  });

  it('is idempotent — normalising twice is normalising once', () => {
    // Load-bearing: a value read from the database has already been normalised, and is
    // normalised again on the way into a Bloom lookup.
    for (const raw of ['  Shubh_Dev ', 'ａｄｍｉｎ', 'shubh']) {
      expect(normaliseUsername(normaliseUsername(raw))).toBe(normaliseUsername(raw));
    }
  });
});

describe('assessUsername — the length band', () => {
  it('refuses six characters for a free account and accepts seven', () => {
    expect(codes('abcdef')).toContain('too_short');
    expect(assessUsername('abcdefg', FREE).ok).toBe(true);
  });

  it('accepts the maximum and refuses one past it', () => {
    expect(assessUsername('a'.repeat(30), FREE).ok).toBe(true);
    expect(codes('a'.repeat(31))).toContain('too_long');
  });

  it('accepts two characters for Premium and refuses them for everyone else', () => {
    expect(assessUsername('ab', PREMIUM).ok).toBe(true);
    expect(codes('ab', FREE)).toContain('too_short');
  });

  it('refuses one character even for Premium — two is the product floor', () => {
    expect(codes('a', PREMIUM)).toContain('too_short');
  });

  it('applies the same maximum to both tiers — Premium buys a floor, not a ceiling', () => {
    expect(PREMIUM.maxLength).toBe(FREE.maxLength);
    expect(codes('a'.repeat(31), PREMIUM)).toContain('too_long');
  });

  it('takes the band as an argument rather than reading an entitlement', () => {
    // The whole reason this is a pure function: the tier is resolved by the service
    // from a port, and a utility that looked it up itself could not be run in the DTO.
    expect(lengthBandFor(false).minLength).toBe(USERNAME.DEFAULT_MIN_LENGTH);
    expect(lengthBandFor(true).minLength).toBe(USERNAME.PREMIUM_MIN_LENGTH);
  });
});

describe('assessUsername — the charset', () => {
  it('accepts lowercase letters, digits and underscores', () => {
    expect(assessUsername('shubh_dev_01', FREE).ok).toBe(true);
  });

  it.each([
    ['a space', 'shubh dev'],
    ['a hyphen', 'shubh-dev'],
    ['a dot', 'shubh.dev'],
    ['an at sign', 'shubh@dev'],
    ['an emoji', 'shubhdev\u{1F600}'],
    ['a zero-width joiner', 'shubh‍dev'],
    ['a right-to-left override', 'shubh‮dev'],
  ])('refuses %s', (_reason, username) => {
    expect(codes(normaliseUsername(username))).toContain('charset');
  });

  it('refuses a leading or trailing underscore', () => {
    // Invisible at the edge of a rendered name, so `_shubh` and `shubh` read as the
    // same person while being different rows.
    expect(codes('_shubhdev')).toContain('edge_underscore');
    expect(codes('shubhdev_')).toContain('edge_underscore');
  });

  it('refuses two underscores in a row', () => {
    expect(codes('shubh__dev')).toContain('edge_underscore');
  });

  it('reports every problem at once rather than the first', () => {
    // A form that could only surface one problem per round trip is one people abandon.
    expect(codes('A!')).toEqual(expect.arrayContaining(['charset', 'too_short']));
  });
});

describe('assessUsername — reserved words', () => {
  it('refuses names that would impersonate the product or its staff', () => {
    for (const reserved of ['support', 'security', 'orebit', 'billing']) {
      expect(codes(reserved)).toContain('reserved');
    }
  });

  it('matches the whole name and not a substring', () => {
    // `supporter` is an ordinary word, and refusing it would generate the support
    // tickets the list exists to prevent.
    expect(assessUsername('supporter', FREE).ok).toBe(true);
    expect(assessUsername('adminium', FREE).ok).toBe(true);
  });

  it('cannot be evaded by casing, because the check runs after normalisation', () => {
    expect(codes(normaliseUsername('SuPPorT'))).toContain('reserved');
  });
});

describe('isProtectedReservation — which reclaims are free', () => {
  it('calls the long, first-change reservation protected', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    expect(
      isProtectedReservation({
        createdAt,
        expiresAt: new Date(createdAt.getTime() + USERNAME.RETENTION_DAYS * 86_400_000),
      }),
    ).toBe(true);
  });

  it('does NOT call a churn release protected', () => {
    // This is the edge that bounds the exploit: every hop of an A -> B -> A ping-pong
    // lands on a name the account itself released moments earlier, so if these counted
    // as protected an unlimited sequence of changes would be free.
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    expect(
      isProtectedReservation({
        createdAt,
        expiresAt: new Date(createdAt.getTime() + USERNAME.RELEASE_SECONDS * 1000),
      }),
    ).toBe(false);
  });

  it('treats the release window itself as the boundary, not something longer', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const justOver = new Date(createdAt.getTime() + USERNAME.RELEASE_SECONDS * 1000 + 1);
    expect(isProtectedReservation({ createdAt, expiresAt: justOver })).toBe(true);
  });
});

describe('suggestionCandidates', () => {
  it('offers alternatives that all satisfy the rules', () => {
    const suggestions = suggestionCandidates('shubh', FREE, 5);

    expect(suggestions.length).toBeGreaterThanOrEqual(3);
    for (const suggestion of suggestions) {
      expect(assessUsername(suggestion, FREE).ok).toBe(true);
    }
  });

  it('never repeats itself', () => {
    const suggestions = suggestionCandidates('shubh', FREE, 8);
    expect(new Set(suggestions).size).toBe(suggestions.length);
  });

  it('returns normalised candidates, so they can be used as lookup keys directly', () => {
    for (const suggestion of suggestionCandidates('Shubh', FREE, 5)) {
      expect(suggestion).toBe(normaliseUsername(suggestion));
    }
  });

  it('offers more than suffixes — a column of numbered variants is not a suggestion', () => {
    const suggestions = suggestionCandidates('shubh', FREE, 8);
    expect(suggestions.some((s) => s.startsWith('its') || s.startsWith('real') || s.startsWith('the'))).toBe(
      true,
    );
  });

  it('still produces suggestions for a stem at the maximum length', () => {
    // The decoration is what makes a suggestion recognisable, so the stem gives way
    // rather than the candidate being dropped.
    const suggestions = suggestionCandidates('a'.repeat(30), FREE, 5);

    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion.length).toBeLessThanOrEqual(USERNAME.MAX_LENGTH);
      expect(assessUsername(suggestion, FREE).ok).toBe(true);
    }
  });

  it('suggests against the stem rather than against a previous suggestion', () => {
    // Asked about `shubh_21`, proposing `shubh_21_37` compounds; the useful answer is
    // another variant of `shubh`.
    const suggestions = suggestionCandidates('shubh_21', FREE, 6);
    expect(suggestions.every((s) => !s.startsWith('shubh_21_'))).toBe(true);
  });

  it('respects a Premium band without producing names a free account could not keep', () => {
    for (const suggestion of suggestionCandidates('ab', PREMIUM, 5)) {
      expect(assessUsername(suggestion, PREMIUM).ok).toBe(true);
    }
  });
});

describe('complianceCandidate — the Premium-expiry suffix', () => {
  it('lengthens a two-character username past the free minimum', () => {
    const candidate = complianceCandidate('ab');

    expect(candidate.startsWith('ab_')).toBe(true);
    expect(assessUsername(candidate, FREE).ok).toBe(true);
  });

  it.each(['ab', 'abc', 'abcd', 'abcde', 'abcdef'])(
    'produces a valid free-tier username from %s',
    (current) => {
      const candidate = complianceCandidate(current);

      expect(candidate.length).toBeGreaterThanOrEqual(USERNAME.DEFAULT_MIN_LENGTH);
      expect(candidate.length).toBeLessThanOrEqual(USERNAME.MAX_LENGTH);
      expect(assessUsername(candidate, FREE).ok).toBe(true);
    },
  );

  it('is different every time, so a collision can be retried', () => {
    const generated = new Set(Array.from({ length: 25 }, () => complianceCandidate('ab')));
    // Not an entropy assertion — just that the reconciler's retry loop has something
    // new to try rather than resubmitting the name that just collided.
    expect(generated.size).toBeGreaterThan(20);
  });

  it('never exceeds the maximum, even from a username already at it', () => {
    const candidate = complianceCandidate('a'.repeat(30));

    expect(candidate.length).toBeLessThanOrEqual(USERNAME.MAX_LENGTH);
    expect(assessUsername(candidate, FREE).ok).toBe(true);
  });

  it('uses an alphabet that cannot be misread or accidentally spell anything', () => {
    // Crockford base32, lowercased: no i, l, o or u.
    for (let i = 0; i < 40; i += 1) {
      const suffix = complianceCandidate('ab').split('_')[1] ?? '';
      expect(suffix).toMatch(/^[0-9a-hjkmnp-tv-z]+$/);
    }
  });
});
