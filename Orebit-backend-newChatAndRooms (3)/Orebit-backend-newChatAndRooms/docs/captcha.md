# Captcha configuration

The backend verifies captcha tokens server-side for all four accepted providers:

- Cloudflare Turnstile (`TURNSTILE`)
- Google reCAPTCHA v2 (`RECAPTCHA_V2`)
- Google reCAPTCHA v3 (`RECAPTCHA_V3`)
- hCaptcha (`HCAPTCHA`)

## Required production environment variables

```dotenv
CAPTCHA_TURNSTILE_SECRET=
CAPTCHA_RECAPTCHA_V2_SECRET=
CAPTCHA_RECAPTCHA_V3_SECRET=
CAPTCHA_HCAPTCHA_SECRET=
```

Production refuses to boot if any provider secret is absent. This is deliberate: the product can select any listed provider, so a missing integration must not silently turn into a captcha bypass.

Optional variables:

```dotenv
# Comma-separated additional verified hostnames. WEB_APP_URL's hostname is always allowed.
CAPTCHA_ALLOWED_HOSTNAMES=

# Timeout for provider siteverify requests; defaults to 5000 milliseconds.
CAPTCHA_TIMEOUT_MS=5000

# Required minimum score for reCAPTCHA v3; defaults to 0.5.
CAPTCHA_RECAPTCHA_V3_MIN_SCORE=0.5
```

## Frontend requirements

Every captcha-bearing request must send `captchaProvider` and `captchaToken`.

For reCAPTCHA v3, execute the token with the exact action for the API operation:

| API operation | reCAPTCHA v3 action |
|---|---|
| Start registration | `register_start` |
| Password login | `login_password` |
| Request login OTP | `login_otp_request` |
| Request password reset | `password_forgot` |

The backend verifies the returned v3 action and score. Tokens from a different page/action are rejected.

## Failure behavior

Verification fails closed. Invalid tokens, untrusted hostnames, a score below the threshold, provider HTTP errors, invalid provider responses, timeouts, and unconfigured providers all refuse the auth request. Provider errors and tokens are never returned to clients.

## Failure counting and the escalating penalty

Rejected tokens are counted per client IP. Cross the threshold and that IP is made to wait, and the wait gets longer each time it happens again.

| | |
|---|---|
| Threshold | 10 rejected tokens per IP (`LIMITS.CAPTCHA_FAILURE_BY_IP`) |
| Window | 15 minutes |
| Penalty ladder | 1 min → 5 min → 15 min → 1 hour, then 1 hour thereafter (`CAPTCHA.BLOCK_LADDER_SECONDS`) |
| Ladder memory | 24 hours (`CAPTCHA.STRIKE_TTL_SECONDS`) |

While a penalty is running the request is refused with `429 rate_limited` and an exact `retryAfterSeconds`. Both values live in `auth/auth.constants.ts`, so changing them is a reviewable diff, not a deploy-time env change.

Four behaviours are deliberate and each has a failure mode worth knowing:

- **The refusal happens before the provider is contacted.** That is the entire point. A penalty applied *after* `siteVerify` would still spend a siteverify call on every request, which is exactly the quota an attacker was burning. `tests/captcha/captcha.service.spec.ts` asserts `fetch` is never called during a penalty.
- **Only caller-attributable failures count.** `captcha_failed` counts. `captcha_provider_unavailable` — timeout, provider 5xx, malformed JSON, unconfigured secret — does **not**. Counting provider outages would turn a Cloudflare incident into a self-inflicted lockout of every legitimate user within minutes.
- **A success clears the failure streak but not the strike count.** Solving a captcha proves the caller is not what this targets, so the streak is wiped. The strike count is kept, because letting one solved token reset the ladder would hand an attacker who can occasionally solve an unlimited supply of first offences.
- **It fails open when Redis is down.** No penalties are enforced rather than everyone being refused. Safe because the captcha itself is still fully verified with the provider on every request — an outage degrades quota protection and can never become a captcha bypass.

The threshold is 10 rather than the 2–3 that feels intuitive because one office, school, or mobile carrier NAT is a **single IP**. A threshold of 3 would let three unrelated people lock out a whole building. reCAPTCHA v3 also fails silently for legitimate users on VPNs — a low score, not a puzzle they can retry — so those users would trip a tight threshold without ever seeing a captcha to fail.

Redis keys (built in `redis/keys.ts`, never inlined):

```
captcha:failures:ip:<hash>   rejected tokens in the current window
captcha:block:ip:<hash>      an active penalty; its TTL is the remaining wait
captcha:strikes:ip:<hash>    ladder position, outlives the block on purpose
```
