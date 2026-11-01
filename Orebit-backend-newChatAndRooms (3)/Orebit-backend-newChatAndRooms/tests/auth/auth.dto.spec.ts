import { describe, expect, it } from "vitest";
import {
  classifyIdentifier,
  emailSchema,
  loginRequestSchema,
  passwordRequestSchema,
  passwordSchema,
  registerRequestSchema,
  sessionRequestSchema,
  toPublicUserPayload,
  updateMyProfileRequestSchema,
  usernameSchema,
} from "../../auth/auth.dto";
import { ERR } from "../../src/contracts";
import { parseDto, ProblemException } from "../../src/http";
import { makePublicUser as publicUser } from "../harness";

/**
 * The DTO layer, which is where most of this module's rules actually live.
 *
 * The controller is a switch over a discriminated union, so anything these
 * schemas let through becomes a service's problem. The tests worth having here
 * are therefore the *cross-field* rules — the ones a per-field schema cannot
 * express and a hand-written check would get subtly wrong — plus the exhaustive
 * discriminator, since an unknown step must be a validation error rather than a
 * silent fall-through.
 */

/**
 * Well-formed flow handles: 43 base64url characters, the length `signupIdSchema`
 * and `loginIdSchema` derive from `SECRET_BYTES`. Anything shorter is rejected as
 * a shape error before the rest of a body is ever looked at, so these are what
 * keeps these tests about the schema under test rather than about the handle.
 */
const SIGNUP_ID = "s".repeat(43);
const LOGIN_ID = "l".repeat(43);

const CAPTCHA = { captchaProvider: "TURNSTILE", captchaToken: "tok" };
const ok = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  value: unknown,
) => schema.safeParse(value).success;

/** The `path` of every issue a failed parse produced. */
function issuePaths(result: {
  success: boolean;
  error?: { issues: { path: unknown[] }[] };
}) {
  return (result.error?.issues ?? []).map((i) => i.path.join("."));
}

describe("passwordSchema", () => {
  it("accepts passwords at both length boundaries when all character classes are present", () => {
    expect(ok(passwordSchema, "Aa1!abcd")).toBe(true);
    expect(ok(passwordSchema, `Aa1!${"a".repeat(16)}`)).toBe(true);
  });

  it.each([
    ["shorter than eight characters", "Aa1!abc"],
    ["longer than 20 characters", `Aa1!${"a".repeat(17)}`],
    ["no lowercase letter", "AA1!BCDE"],
    ["no uppercase letter", "aa1!bcde"],
    ["no number", "Aa!bcdef"],
    ["no special character", "Aa1bcdef"],
    ["only whitespace instead of a special character", "Aa1 abcde"],
  ])("rejects a password with %s", (_reason, password) => {
    expect(ok(passwordSchema, password)).toBe(false);
  });
});

describe("usernameSchema", () => {
  // This schema bounds the SHAPE of a username, not the band any particular account is
  // entitled to. The floor is `PREMIUM_MIN_LENGTH` — the shortest name the product
  // issues to anyone — because the applicable minimum depends on an entitlement the DTO
  // layer cannot resolve. `UsernameService` re-checks the band against the tier it
  // looked up itself; see the note on the schema.
  it("accepts the full span the product can issue, two through 30 characters", () => {
    expect(ok(usernameSchema, "ab")).toBe(true);
    expect(ok(usernameSchema, "a".repeat(30))).toBe(true);
  });

  it("rejects lengths no account could ever hold", () => {
    expect(ok(usernameSchema, "a")).toBe(false);
    expect(ok(usernameSchema, "a".repeat(31))).toBe(false);
  });

  it("accepts only lowercase letters, digits and underscores", () => {
    expect(ok(usernameSchema, "shubh_dev1")).toBe(true);
    expect(ok(usernameSchema, "shubh-dev")).toBe(false);
    expect(ok(usernameSchema, "shubh.dev")).toBe(false);
    // Non-ASCII is refused outright rather than folded, which is what closes the
    // homoglyph hole — see `normaliseUsername`.
    expect(ok(usernameSchema, "shubhdevа")).toBe(false);
  });
});

describe("emailSchema", () => {
  it("accepts valid email addresses up to 254 characters (RFC 5321)", () => {
    expect(ok(emailSchema, "a@b.co")).toBe(true);

    // Construct valid 254-character email: local 64 chars + @ (1) + domain 189 chars = 254
    const local = "a".repeat(64);
    const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    const email254 = `${local}@${domain}`;
    expect(email254.length).toBe(254);
    expect(ok(emailSchema, email254)).toBe(true);
  });

  it("rejects emails exceeding the 254 character limit", () => {
    const local = "a".repeat(64);
    const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`;
    const email255 = `${local}@${domain}`;
    expect(email255.length).toBe(255);
    expect(ok(emailSchema, email255)).toBe(false);
  });

  it("rejects emails shorter than 3 characters or with invalid syntax", () => {
    expect(ok(emailSchema, "")).toBe(false);
    expect(ok(emailSchema, "a@")).toBe(false);
    expect(ok(emailSchema, "@b")).toBe(false);
    expect(ok(emailSchema, "not-an-email")).toBe(false);
  });
});

describe("registerRequestSchema — the credentials step password/skip rules", () => {
  it("accepts skip:true with no password", () => {
    expect(ok(registerRequestSchema, { step: "credentials", signupId: SIGNUP_ID, skip: true })).toBe(
      true,
    );
  });

  it("accepts skip:false with a strong password", () => {
    expect(
      ok(registerRequestSchema, {
        step: "credentials", signupId: SIGNUP_ID,
        skip: false,
        password: "Str0ng!Passw0rd",
      }),
    ).toBe(true);
  });

  it("rejects setting a password AND skipping", () => {
    // Contradictory. Resolving it silently to either one would mean the account
    // ends up in a state the user did not choose.
    const result = registerRequestSchema.safeParse({
      step: "credentials", signupId: SIGNUP_ID,
      skip: true,
      password: "Str0ng!Passw0rd",
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("password");
  });

  it("rejects doing neither", () => {
    // Would create an account whose owner believes they set a password.
    const result = registerRequestSchema.safeParse({
      step: "credentials", signupId: SIGNUP_ID,
      skip: false,
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("password");
  });

  it("rejects a weak password even when skip is false", () => {
    expect(
      ok(registerRequestSchema, {
        step: "credentials", signupId: SIGNUP_ID,
        skip: false,
        password: "short",
      }),
    ).toBe(false);
  });
});

describe("registerRequestSchema — the discriminator", () => {
  it.each([
    ["start", { step: "start", email: "ada@example.test", ...CAPTCHA }],
    ["resend-otp", { step: "resend-otp", signupId: SIGNUP_ID }],
    ["verify-email", { step: "verify-email", signupId: SIGNUP_ID, code: "123456" }],
    ["check-referral", { step: "check-referral", signupId: SIGNUP_ID, code: "ABCD1234" }],
    ["check-referral (no code)", { step: "check-referral", signupId: SIGNUP_ID }],
    ["credentials", { step: "credentials", signupId: SIGNUP_ID, skip: true }],
    ["country", { step: "country", signupId: SIGNUP_ID, country: "GB" }],
    ["trust-device", { step: "trust-device", signupId: SIGNUP_ID, trust: true }],
    ["state", { step: "state", signupId: SIGNUP_ID }],
  ])("accepts step %s", (_name, body) => {
    expect(ok(registerRequestSchema, body)).toBe(true);
  });

  it("rejects an unknown step rather than ignoring it", () => {
    expect(ok(registerRequestSchema, { step: "teleport" })).toBe(false);
  });

  it("rejects a missing step", () => {
    expect(ok(registerRequestSchema, { email: "ada@example.test" })).toBe(
      false,
    );
  });

  it("reports issues against the MATCHED variant only", () => {
    // A plain union would report all seven variants' failures for one bad body,
    // which is unusable for a client trying to highlight a field.
    const result = registerRequestSchema.safeParse({
      step: "verify-email", signupId: SIGNUP_ID,
      code: "abc",
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(["code"]);
  });

  it("requires a captcha on start", () => {
    expect(
      ok(registerRequestSchema, { step: "start", email: "ada@example.test" }),
    ).toBe(false);
  });

  it("does not require a captcha on the steps that carry a signupId", () => {
    expect(
      ok(registerRequestSchema, { step: "verify-email", signupId: SIGNUP_ID, code: "123456" }),
    ).toBe(true);
  });
});

describe("registerRequestSchema — field normalisation", () => {
  it("trims and uppercases the country", () => {
    const parsed = registerRequestSchema.parse({
      step: "country", signupId: SIGNUP_ID,
      country: "  gb ",
    });
    expect(parsed).toMatchObject({ country: "GB" });
  });

  it("rejects a well-formed but unassigned country code", () => {
    expect(ok(registerRequestSchema, { step: "country", signupId: SIGNUP_ID, country: "ZZ" })).toBe(
      false,
    );
  });

  it("trims the OTP but requires exactly six digits", () => {
    expect(
      registerRequestSchema.parse({ step: "verify-email", signupId: SIGNUP_ID, code: " 123456 " }),
    ).toMatchObject({
      code: "123456",
    });
    expect(
      ok(registerRequestSchema, { step: "verify-email", signupId: SIGNUP_ID, code: "12345" }),
    ).toBe(false);
    expect(
      ok(registerRequestSchema, { step: "verify-email", signupId: SIGNUP_ID, code: "1234567" }),
    ).toBe(false);
    expect(
      ok(registerRequestSchema, { step: "verify-email", signupId: SIGNUP_ID, code: "abcdef" }),
    ).toBe(false);
  });
});

describe("loginRequestSchema", () => {
  it.each([
    [
      "password",
      {
        step: "password",
        identifier: "ada",
        password: "Str0ng!Passw0rd",
        ...CAPTCHA,
      },
    ],
    ["otp-request", { step: "otp-request", loginId: LOGIN_ID, identifier: "ada", ...CAPTCHA }],
    ["otp-verify", { step: "otp-verify", loginId: LOGIN_ID, code: "123456" }],
    ["oauth-start", { step: "oauth-start", provider: "GOOGLE" }],
    [
      "oauth-callback",
      {
        step: "oauth-callback", loginId: LOGIN_ID,
        provider: "GOOGLE",
        code: "auth-code",
        state: "st",
      },
    ],
    [
      "oauth-register",
      { step: "oauth-register", loginId: LOGIN_ID, linkToken: "tok" },
    ],
  ])("accepts step %s", (_name, body) => {
    expect(ok(loginRequestSchema, body)).toBe(true);
  });

  it.each([
    [
      "password",
      {
        step: "password",
        identifier: "ada",
        password: "pw",
        ...CAPTCHA,
      },
    ],
    ["otp-request", { step: "otp-request", loginId: LOGIN_ID, identifier: "ada", ...CAPTCHA }],
    ["otp-verify", { step: "otp-verify", loginId: LOGIN_ID, code: "123456" }],
  ])("REFUSES a linkToken on step %s", (_name, body) => {
    // The schema is `.strict()`, so an unknown key is rejected rather than dropped
    // — and that strictness is doing real work here. Linking used to ride on these
    // three modes, which made writing an `OauthLink` a side effect of presenting one
    // factor: read a mailbox, sign in with the emailed code, attach your own Google
    // account, and keep access after the victim changes their password.
    //
    // A client still sending the old field gets a loud validation error rather than
    // a silently ignored one, which is what makes the migration visible instead of
    // leaving somebody convinced they linked something. Linking is now
    // `POST /auth/link` — authenticated, and behind an elevation ticket.
    expect(ok(loginRequestSchema, body)).toBe(true);
    expect(ok(loginRequestSchema, { ...body, linkToken: "tok" })).toBe(false);
  });

  it("requires a linkToken on oauth-register, where it is the whole request", () => {
    // This one KEEPS its token, and the difference is the point: it consumes a
    // pending identity to begin a NEW registration, so there is no existing account
    // for it to take over.
    expect(ok(loginRequestSchema, { step: "oauth-register", loginId: LOGIN_ID })).toBe(false);
    expect(ok(loginRequestSchema, { step: "oauth-register", loginId: LOGIN_ID, linkToken: "tok" })).toBe(true);
  });

  it("rejects a linkToken past the bound it shares with state", () => {
    expect(
      ok(loginRequestSchema, { step: "oauth-register", loginId: LOGIN_ID, linkToken: "t".repeat(513) }),
    ).toBe(false);
  });

  it("accepts every provider that has an adapter, configured or not", () => {
    // This used to reject everything but GOOGLE, on the reasoning that accepting a
    // provider nothing implemented would turn a client mistake into a 502. Adapters
    // now exist for all five, so the refusal moved rather than disappeared:
    // `OauthProviderRegistry.require` answers `oauth_provider_unsupported` — a 400
    // that names the provider — when its credentials are absent.
    //
    // The point of the move is that the wire contract no longer changes when a
    // deployment gains credentials. Asserted for each provider rather than for one,
    // because a provider dropped from this enum would otherwise fail as a 400 from
    // validation and look identical to one that is merely unconfigured.
    for (const provider of ["GOOGLE", "X", "TELEGRAM", "APPLE", "FACEBOOK"]) {
      expect(
        ok(loginRequestSchema, { step: "oauth-start", provider }),
      ).toBe(true);
    }
  });

  it("still rejects a provider that is not in the enum at all", () => {
    expect(
      ok(loginRequestSchema, { step: "oauth-start", provider: "MYSPACE" }),
    ).toBe(false);
  });

  it("rejects a malformed redirectUri", () => {
    expect(
      ok(loginRequestSchema, {
        step: "oauth-start",
        provider: "GOOGLE",
        redirectUri: "not a url at all",
      }),
    ).toBe(false);
  });

  it("accepts a javascript: URI here — the DTO is a shape check, NOT the control", () => {
    // Worth pinning explicitly, because it looks like a hole and is not one.
    // `z.string().url()` follows the WHATWG parser, for which `javascript:...` is
    // a well-formed URL. What actually closes the open redirect is
    // `resolveRedirectUri` in oauth.service.ts, which demands exact equality with
    // the configured GOOGLE_REDIRECT_URI — see the oauth.service spec.
    //
    // If anyone ever relaxes that downstream check believing this schema screens
    // the value, this test is the thing that says otherwise.
    expect(
      ok(loginRequestSchema, {
        step: "oauth-start",
        provider: "GOOGLE",
        redirectUri: "javascript:alert(1)",
      }),
    ).toBe(true);
  });

  it("does NOT apply full password policy on login — this is a check, not a set", () => {
    // A user whose existing password predates the current policy must still be
    // able to sign in and be told to change it.
    expect(
      ok(loginRequestSchema, {
        step: "password",
        identifier: "ada",
        password: "weak",
        ...CAPTCHA,
      }),
    ).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(
      ok(loginRequestSchema, { step: "telepathy", loginId: LOGIN_ID, identifier: "ada" }),
    ).toBe(false);
  });
});

describe("passwordRequestSchema — set and change, both authenticated", () => {
  const set = {
    action: "set" as const,
    code: "123456",
  };

  it("accepts a matching confirmation", () => {
    expect(
      ok(passwordRequestSchema, {
        ...set,
        password: "Br4nd!NewPassw0rd",
        confirmPassword: "Br4nd!NewPassw0rd",
      }),
    ).toBe(true);
  });

  it("rejects a mismatched confirmation, reporting it against confirmPassword", () => {
    const result = passwordRequestSchema.safeParse({
      ...set,
      password: "Br4nd!NewPassw0rd",
      confirmPassword: "Different!Passw0rd",
    });

    expect(result.success).toBe(false);
    // The path matters: the client highlights the second box, not the first.
    expect(issuePaths(result)).toContain("confirmPassword");
  });

  it("applies FULL password policy to the new password — this is a set, not a check", () => {
    expect(
      ok(passwordRequestSchema, { ...set, password: "weak", confirmPassword: "weak" }),
    ).toBe(false);
  });

  it("takes no captcha and no email — the route is authenticated now", () => {
    // Both were required when this was public recovery. The session supplies the
    // account, so an email field would be a way to name somebody else's.
    expect(ok(passwordRequestSchema, { action: "request-code" })).toBe(true);
  });

  it("does NOT let change carry an emailed code", () => {
    // Two proofs for one action means the weaker one is the only one that matters.
    const result = passwordRequestSchema.safeParse({
      action: "change",
      code: "123456",
      currentPassword: "Old!Passw0rd",
      password: "Br4nd!NewPassw0rd",
      confirmPassword: "Br4nd!NewPassw0rd",
    });

    // The extra key is ignored rather than rejected, but it is never read — what
    // matters is that `change` has no `code` in its shape at all.
    expect(result.success).toBe(true);
    expect(result.success && "code" in result.data).toBe(false);
  });

  it("requires the current password on change", () => {
    expect(
      ok(passwordRequestSchema, {
        action: "change",
        password: "Br4nd!NewPassw0rd",
        confirmPassword: "Br4nd!NewPassw0rd",
      }),
    ).toBe(false);
  });

  it("does not hold the CURRENT password to the new-password policy", () => {
    // An existing password predates the current rules and must still be
    // presentable, or the users whose passwords most need changing cannot.
    expect(
      ok(passwordRequestSchema, {
        action: "change",
        currentPassword: "old",
        password: "Br4nd!NewPassw0rd",
        confirmPassword: "Br4nd!NewPassw0rd",
      }),
    ).toBe(true);
  });
});

describe("sessionRequestSchema", () => {
  it("needs nothing but the action — the credential is the orebit_session cookie", () => {
    expect(ok(sessionRequestSchema, { action: "logout" })).toBe(true);
    expect(ok(sessionRequestSchema, { action: "logout-all" })).toBe(true);
  });

  it("no longer accepts a refresh action at all", () => {
    // The backend rotates its own tokens now, inside AuthGuard, so there is nothing
    // for a client to ask for. Removed rather than kept as a no-op 200: a stale
    // client polling a refresh it never receives would look healthy while doing
    // nothing, and the failure would surface later as an unexplained sign-out.
    expect(ok(sessionRequestSchema, { action: "refresh" })).toBe(false);
  });

  it("rejects a body carrying a token, rather than stripping it", () => {
    // This file used to assert the opposite, and the tolerance was right while the
    // body was the thing being emptied. It is wrong now that the body is empty by
    // design: a client sending `refreshToken` believes it holds a credential it
    // cannot hold, and `.strict()` says so at the edge instead of accepting the
    // request and quietly ignoring the field.
    const parsed = sessionRequestSchema.safeParse({
      action: "logout",
      refreshToken: "rt",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown action", () => {
    expect(ok(sessionRequestSchema, { action: "logout-some" })).toBe(false);
  });
});

describe("classifyIdentifier — one input box, three columns", () => {
  it("classifies an address as an email", () => {
    expect(classifyIdentifier("ada@example.test")).toBe("email");
  });

  it("classifies an OREBiT code as a publicCode", () => {
    expect(classifyIdentifier("OREBiT7Q9K2M4X")).toBe("publicCode");
  });

  it("falls back to username for anything else", () => {
    // Deliberately the fallback rather than an error: the product cannot ask the
    // client to answer "is `abc123` a username or a code?".
    expect(classifyIdentifier("ada_lovelace")).toBe("username");
    expect(classifyIdentifier("abc123")).toBe("username");
  });
});

// ─── the account/profile DTOs ────────────────────────────────────────────────
//
// These moved here with the account code itself: `updateMyProfileRequestSchema`
// now lives in dto/common.dto.ts and `toPublicUserPayload` in dto/response.dto.ts,
// so both reach this file through the same `auth.dto` barrel as everything above.

describe("updateMyProfileRequestSchema", () => {
  it('trims and uppercases the country, so "  gb " is stored as "GB"', () => {
    const parsed = updateMyProfileRequestSchema.parse({ country: "  gb " });
    expect(parsed).toEqual({ country: "GB" });
  });

  it("rejects anything that is not two characters", () => {
    expect(updateMyProfileRequestSchema.safeParse({ country: "GBR" }).success).toBe(false);
    expect(updateMyProfileRequestSchema.safeParse({ country: "G" }).success).toBe(false);
    expect(updateMyProfileRequestSchema.safeParse({ country: "" }).success).toBe(false);
  });

  it("rejects a well-formed code that is not an assigned country", () => {
    // Length alone is not validation: ZZ is unassigned, and the country list is
    // a reviewable literal in src/utils/country.ts precisely so this check
    // cannot drift with a dependency bump.
    const result = updateMyProfileRequestSchema.safeParse({ country: "ZZ" });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe("Unknown country code");
  });

  it("rejects unknown keys instead of ignoring them", () => {
    // `.strict()` is what stops a client from believing it updated a field the
    // API does not expose — silently discarding `username` here would read as a
    // successful rename.
    const result = updateMyProfileRequestSchema.safeParse({
      country: "GB",
      username: "someone_else",
    });

    expect(result.success).toBe(false);
  });

  it("requires the country to be present", () => {
    expect(updateMyProfileRequestSchema.safeParse({}).success).toBe(false);
    expect(updateMyProfileRequestSchema.safeParse(undefined).success).toBe(false);
  });

  it("turns a failure into a validation_failed problem with the offending path", () => {
    // The contract a client parses: `parseDto` is the only place a body is
    // checked, and it always reports through the one problem shape.
    try {
      parseDto(updateMyProfileRequestSchema, { country: "ZZ" });
      expect.unreachable("parseDto should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemException);
      const problem = err as ProblemException;
      expect(problem.type).toBe(ERR.VALIDATION_FAILED);
      expect(problem.status).toBe(400);
      expect(problem.errors?.[0]).toEqual({ path: "country", message: "Unknown country code" });
    }
  });

  it("shares one country rule with the registration step", () => {
    // Both read `countrySchema` from dto/common.dto.ts. If they ever diverged, a
    // country accepted at signup could be rejected on the profile that signup
    // created.
    const viaProfile = updateMyProfileRequestSchema.safeParse({ country: "gb" });
    expect(viaProfile.success).toBe(true);
    if (!viaProfile.success) return;
    expect(viaProfile.data.country).toBe("GB");
  });
});

describe("toPublicUserPayload", () => {
  it("serialises registeredAt as ISO 8601 and passes the rest through", () => {
    expect(toPublicUserPayload(publicUser())).toEqual({
      publicCode: "OREBiT7Q9K2M4X",
      username: "ada_lovelace",
      email: "Ada.Lovelace@example.test",
      emailVerified: true,
      country: "GB",
      referralCode: "K7M2P9QR",
      hasPassword: true,
      registeredAt: "2026-01-15T10:00:00.000Z",
      avatarUrl: null,
    });
  });

  it("keeps a null country null rather than coercing it to a string", () => {
    expect(toPublicUserPayload(publicUser({ country: null })).country).toBeNull();
  });

  it("exposes exactly the wire contract and nothing more", () => {
    expect(Object.keys(toPublicUserPayload(publicUser())).sort()).toEqual([
      "avatarUrl",
      "country",
      "email",
      "emailVerified",
      "hasPassword",
      "publicCode",
      "referralCode",
      "registeredAt",
      "username",
    ]);
  });
});
