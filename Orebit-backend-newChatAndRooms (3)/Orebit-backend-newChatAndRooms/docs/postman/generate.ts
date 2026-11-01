import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keep the checked-in Postman collection discoverable from the route contract.
 * The detailed request bodies remain curated in the collection; this generator owns
 * the stable method/path labels consumed by drift tests and adds new auth surfaces.
 */
const output = join(process.cwd(), 'docs/postman/orebit-auth.postman_collection.json');

/**
 * ─── Why an absent file is a starting point rather than a crash ─────────────
 *
 * This read used to be unguarded, which made the generator unable to run on exactly the
 * branches that need it most: one where the collection has not been committed yet. That
 * matters because re-running this is the DOCUMENTED fix — `openapi.drift.spec.ts` fails
 * with "run: npx tsx docs/postman/generate.ts" — and an instruction that throws
 * ENOENT is not a fix.
 *
 * So a missing file starts an empty collection and the append passes below fill it. The
 * result is label-complete but body-less, which is the honest state of an artifact
 * nobody has curated yet; a curated file on disk is left alone apart from the folders
 * this generator owns.
 */
type Collection = {
  info?: Record<string, unknown>;
  item: Array<{ name: string; item: Array<{ name: string; request?: unknown }> }>;
};

const collection: Collection = existsSync(output)
  ? (JSON.parse(readFileSync(output, 'utf8')) as Collection)
  : {
      info: {
        name: 'Orebit — Auth & Settings',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [],
    };

const routeForFolder: Record<string, string> = {
  '1. Registration — POST /auth/register': 'POST /auth/register',
  '2. Login — POST /auth/login': 'POST /auth/login',
  '3. Session — POST /auth/session': 'POST /auth/session',
  '4. Password — POST /auth/password': 'POST /auth/password',
};

/** A name already in the canonical `METHOD /path` form this generator produces. */
const ALREADY_LABELLED = /^(?:GET|POST|PUT|PATCH|DELETE) \//;

/**
 * Prefix once, however many times this runs.
 *
 * The append passes below are guarded by `has*` checks, but this rename pass was
 * not, so a second run produced `POST /auth/register — POST /auth/register — start`
 * and a third made it worse. That matters because re-running is the DOCUMENTED fix:
 * the drift test's failure message is literally "run: npx tsx docs/postman/generate.ts".
 * A generator you are told to re-run has to be safe to re-run.
 *
 * ─── Why the second guard, on the name's own shape ─────────────────────────
 *
 * The first guard only recognises the route it is about to apply, so it protects a
 * request against being prefixed TWICE with the same route and not against being
 * prefixed with the WRONG one. The devices pass below is where that bites: it prefixes
 * every non-`GET` request in its folder with `POST /auth/device`, on the assumption
 * that a folder about devices contains nothing else. A curated collection that also
 * files `PATCH /auth/me` there — a reasonable place for it — came out as
 * `POST /auth/device — PATCH /auth/me`, which then has no request for `PATCH /auth/me`
 * at all and fails the drift test the generator exists to satisfy.
 *
 * So a name that is already a canonical label is left alone. The rename pass is for
 * legacy prose names like `start` and `trust`; anything already carrying a method and a
 * path has been through here, or was written by hand in the form this produces, and in
 * both cases the answer is to do nothing.
 */
function prefixOnce(request: { name: string }, route: string): void {
  if (request.name.startsWith(`${route} —`)) return;
  if (ALREADY_LABELLED.test(request.name)) return;
  request.name = `${route} — ${request.name}`;
}

for (const folder of collection.item) {
  const route = routeForFolder[folder.name];
  if (route !== undefined) {
    for (const request of folder.item) prefixOnce(request, route);
  }
  if (folder.name.startsWith('5. Devices')) {
    for (const request of folder.item) {
      if (request.name.startsWith('GET ')) continue;
      prefixOnce(request, 'POST /auth/device');
    }
  }
}

/**
 * ═══ THE SESSION FOLDER, WHICH LOST AN ACTION AND GAINED A ROUTE ═══════════
 *
 * The only pass here that REMOVES something, and the only one that reaches inside a
 * curated folder to do it. Both halves are needed and neither is cosmetic.
 *
 * `POST /auth/session — refresh` no longer exists: the backend rotates its own tokens,
 * so `{"action":"refresh"}` is `400 validation_failed`. A request left in the
 * collection would be a documented call that always fails, which is worse than an
 * undocumented one — somebody would send it and conclude the service was broken.
 *
 * `GET /auth/session` is the route a page calls on load, and `openapi.drift.spec.ts`
 * requires every runtime route to appear here. Appended rather than added to the
 * `hasSession` guard's own creation branch, because that folder is curated and
 * already exists on disk: this file's whole discipline is to leave curated content
 * alone apart from what it owns.
 *
 * Idempotent, like every other pass: the removal matches nothing on a second run, and
 * the append is guarded by name.
 */
const sessionFolder = collection.item.find(
  (folder) => folder.name === '3. Session — POST /auth/session',
);
if (sessionFolder !== undefined) {
  sessionFolder.item = sessionFolder.item.filter(
    (request) => !request.name.startsWith('POST /auth/session — refresh'),
  );
  if (!sessionFolder.item.some((request) => request.name.startsWith('GET /auth/session'))) {
    sessionFolder.item.unshift({
      name: 'GET /auth/session',
      request: { method: 'GET', header: [], url: `{{baseUrl}}/auth/session` },
    });
  }
  if (!sessionFolder.item.some((request) => request.name.startsWith('POST /auth/session — revoke-session'))) {
    sessionFolder.item.push({
      name: 'POST /auth/session — revoke-session',
      request: { method: 'POST', header: [], url: `{{baseUrl}}/auth/session` },
    });
  }
}

const hasTwoFactor = collection.item.some((folder) => folder.name === '8. Two-factor — /auth/2fa');
if (!hasTwoFactor) {
  const simple = (name: string, method: string, path: string) => ({
    name,
    request: { method, header: [], url: `{{baseUrl}}${path}` },
  });
  collection.item.push({
    name: '8. Two-factor — /auth/2fa',
    item: [
      simple('GET /auth/2fa', 'GET', '/auth/2fa'),
      simple('POST /auth/2fa — credential-otp', 'POST', '/auth/2fa'),
      simple('POST /auth/2fa — totp-add', 'POST', '/auth/2fa'),
      simple('POST /auth/2fa — totp-confirm', 'POST', '/auth/2fa'),
      simple('POST /auth/2fa — passkey-add-challenge', 'POST', '/auth/2fa'),
      simple('POST /auth/2fa — passkey-add-verify', 'POST', '/auth/2fa'),
      simple('POST /auth/2fa — reauth-challenge', 'POST', '/auth/2fa'),
      simple('POST /auth/2fa — reauth-verify', 'POST', '/auth/2fa'),
      simple('POST /auth/2fa/verify', 'POST', '/auth/2fa/verify'),
    ],
  });
}

const hasRemainingRoutes = collection.item.some((folder) => folder.name === '9. Auth endpoints');
if (!hasRemainingRoutes) {
  const simple = (name: string, method: string, path: string) => ({
    name,
    request: { method, header: [], url: `{{baseUrl}}${path}` },
  });
  collection.item.push({
    name: '9. Auth endpoints',
    item: [
      simple('GET /auth/sessions', 'GET', '/auth/sessions'),
      simple('POST /auth/link/preview', 'POST', '/auth/link/preview'),
      simple('POST /auth/link', 'POST', '/auth/link'),
    ],
  });
}

const hasSettings = collection.item.some((folder) => folder.name === '10. Settings — /settings');
if (!hasSettings) {
  const simple = (name: string, method: string, path: string) => ({
    name,
    request: { method, header: [], url: `{{baseUrl}}${path}` },
  });
  collection.item.push({
    name: '10. Settings — /settings',
    item: [
      simple('GET /settings/security/passkeys', 'GET', '/settings/security/passkeys'),
      // Two entries for one path, matching how the Two-factor folder splits a
      // multi-action route: the drift test prefix-matches on "METHOD /path — action".
      simple(
        'POST /settings/security/passkeys — enable-challenge',
        'POST',
        '/settings/security/passkeys',
      ),
      simple(
        'POST /settings/security/passkeys — enable-verify',
        'POST',
        '/settings/security/passkeys',
      ),
      simple(
        'POST /settings/security/passkeys/disable',
        'POST',
        '/settings/security/passkeys/disable',
      ),
      simple('GET /settings/security/authenticator', 'GET', '/settings/security/authenticator'),
      simple(
        'POST /settings/security/authenticator — enable-challenge',
        'POST',
        '/settings/security/authenticator',
      ),
      simple(
        'POST /settings/security/authenticator — enable-verify',
        'POST',
        '/settings/security/authenticator',
      ),
      simple(
        'POST /settings/security/authenticator/disable',
        'POST',
        '/settings/security/authenticator/disable',
      ),
    ],
  });
}

/**
 * The Payment PIN.
 *
 * Its own folder rather than three more entries in `10. Settings`, because it is a
 * three-call FLOW — status, verify, act — and a reader working through it should not
 * have to pick its requests out of the two factor surfaces. The same reason the
 * two-factor routes are not folded into `9. Auth endpoints`.
 *
 * Both `POST` paths appear once per action, matching how the Two-factor folder splits a
 * multi-action route: the drift test prefix-matches on "METHOD /path — action", and one
 * request with three mutually exclusive bodies squashed together would be worse than
 * nothing.
 */
const hasPaymentPin = collection.item.some((folder) =>
  folder.name.startsWith('11. Payment PIN'),
);
if (!hasPaymentPin) {
  const simple = (name: string, method: string, path: string) => ({
    name,
    request: { method, header: [], url: `{{baseUrl}}${path}` },
  });
  const base = '/settings/security/payment-pin';
  collection.item.push({
    name: `11. Payment PIN — ${base}`,
    item: [
      simple(`GET ${base}`, 'GET', base),
      simple(`POST ${base} — enable`, 'POST', base),
      // Verification carries the operation as well as the method: the challenge it
      // returns is bound to ONE of update/disable and will not work for the other.
      simple(`POST ${base}/verify — pin`, 'POST', `${base}/verify`),
      simple(`POST ${base}/verify — authenticator`, 'POST', `${base}/verify`),
      simple(`POST ${base}/verify — passkey`, 'POST', `${base}/verify`),
      simple(`POST ${base} — update`, 'POST', base),
      simple(`POST ${base} — disable`, 'POST', base),
    ],
  });
}

/**
 * Changing the account's email, and recovering from a change that was not the owner's
 * doing.
 *
 * Its own folder rather than more entries in `10. Settings`, for the reason the Payment
 * PIN has one: it is a FLOW, and a reader working through it should not have to pick its
 * requests out of the factor surfaces.
 *
 * Both POSTs appear once per action. Note that `recover-start` and the recovery
 * completion are the only requests in this collection reachable WITHOUT a session — a
 * completed change revokes every session, so the person a recovery exists for is
 * precisely the one who cannot authenticate.
 */
const hasEmail = collection.item.some((folder) => folder.name.startsWith('12. Email'));
if (!hasEmail) {
  const simple = (name: string, method: string, path: string) => ({
    name,
    request: { method, header: [], url: `{{baseUrl}}${path}` },
  });
  const base = '/settings/security/email';
  collection.item.push({
    name: `12. Email — ${base}`,
    item: [
      simple(`GET ${base}`, 'GET', base),
      simple(`POST ${base} — start`, 'POST', base),
      simple(`POST ${base} — resend`, 'POST', base),
      simple(`POST ${base} — recover-start`, 'POST', base),
      simple(`POST ${base}/verify — change`, 'POST', `${base}/verify`),
      simple(`POST ${base}/verify — recovery`, 'POST', `${base}/verify`),
    ],
  });
}

/**
 * Changing the account's username.
 *
 * Its own folder rather than more entries in `10. Settings`, for the reason the Payment
 * PIN and Email folders have one: it is a flow a reader works through in order — see the
 * rules, probe a name, save it — and its requests should not be scattered among the
 * factor surfaces.
 *
 * `/check` carries its argument in the query string rather than a body, which is the one
 * thing worth noticing in this collection: it is called on a debounce while the user
 * types, so it has to be a cacheable GET the browser can cancel, not a write-shaped
 * request per keystroke.
 *
 * These sit under `/settings/profile/` and not `/settings/security/`, which is a real
 * distinction rather than filing — a username identifies an account publicly and
 * authenticates nobody, so it is not part of the set frozen by the security cooldown.
 */
const hasUsername = collection.item.some((folder) => folder.name.startsWith('13. Username'));
if (!hasUsername) {
  const simple = (name: string, method: string, path: string) => ({
    name,
    request: { method, header: [], url: `{{baseUrl}}${path}` },
  });
  const base = '/settings/profile/username';
  collection.item.push({
    name: `13. Username — ${base}`,
    item: [
      simple(`GET ${base}`, 'GET', base),
      simple(`GET ${base}/check`, 'GET', `${base}/check?username=shubh_dev`),
      simple(`POST ${base}`, 'POST', base),
    ],
  });
}

/**
 * The account password, as a security setting.
 *
 * Its own folder rather than more entries in `10. Settings`, for the reason the Payment
 * PIN, Email and Username folders have one: it is a FLOW a reader works through in
 * order — read the status, request a code, act — and its requests should not be
 * scattered among the factor surfaces.
 *
 * ─── Why this is a fourteenth folder and not more entries in `4. Password` ──
 *
 * `4. Password — POST /auth/password` is the LEGACY route, and it is deliberately left
 * alone. Its `set` action now refuses an account that has both a password and an
 * enabled factor, because it has no field for the proof that case requires — see
 * `PasswordService.assertNotAFactorDowngrade`. Folding the two into one folder would
 * present a superseded contract and its replacement as one flow.
 *
 * The `POST` appears once per action, matching how the Two-factor and Payment PIN
 * folders split a multi-action route: the drift test prefix-matches on
 * "METHOD /path — action", and one request with three mutually exclusive bodies
 * squashed together would be worse than nothing.
 *
 * `forgot` appears TWICE rather than once, and that is the entry worth noticing in this
 * collection: whether it needs a second proof is decided by the BACKEND from the
 * account's confirmed factors, so the two requests are the two shapes a caller will
 * actually send — and which one applies is read from `GET`'s `forgot.factorRequired`,
 * never chosen by the client.
 */
const hasPassword = collection.item.some((folder) => folder.name.startsWith('14. Password'));
if (!hasPassword) {
  const simple = (name: string, method: string, path: string) => ({
    name,
    request: { method, header: [], url: `{{baseUrl}}${path}` },
  });
  const base = '/settings/security/password';
  collection.item.push({
    name: `14. Password — ${base}`,
    item: [
      simple(`GET ${base}`, 'GET', base),
      simple(`POST ${base} — set`, 'POST', base),
      simple(`POST ${base} — reset`, 'POST', base),
      simple(`POST ${base} — forgot (no factor enrolled)`, 'POST', base),
      simple(`POST ${base} — forgot (passkey or authenticator)`, 'POST', base),
    ],
  });
}

/**
 * The anti-phishing code — the string printed in outbound mail so a reader can
 * recognise a genuine message.
 *
 * The `POST` appears once per action, matching how the Two-factor, Payment PIN and
 * Password folders split a multi-action route: the drift test prefix-matches on
 * "METHOD /path — action", and one request with three mutually exclusive bodies
 * squashed together would be worse than nothing.
 *
 * `change` and `replace` are both listed, and the pair is the entry worth noticing in
 * this collection: they perform the SAME write, and `replace` needs strictly less —
 * no `currentCode` at all. That is deliberate rather than an oversight (the value lives
 * in the user's inbox, not their memory), and `currentCode` on `change` is
 * mistake-prevention rather than a control. Anyone reading this folder as a security
 * surface should read the operation description in openapi.json first.
 */
const hasAntiPhishing = collection.item.some((folder) =>
  folder.name.startsWith('15. Anti-phishing'),
);
if (!hasAntiPhishing) {
  const simple = (name: string, method: string, path: string) => ({
    name,
    request: { method, header: [], url: `{{baseUrl}}${path}` },
  });
  const base = '/settings/security/anti-phishing';
  collection.item.push({
    name: `15. Anti-phishing — ${base}`,
    item: [
      simple(`GET ${base}`, 'GET', base),
      simple(`POST ${base} — set`, 'POST', base),
      simple(`POST ${base} — change (knows the current code)`, 'POST', base),
      simple(`POST ${base} — replace (does not know it)`, 'POST', base),
    ],
  });
}

/**
 * Attaching a social provider to an account that already exists.
 *
 * Its own folder rather than more entries in `10. Settings`, for the reason the Payment
 * PIN, Email, Username and Password folders have one: it is a FLOW a reader works
 * through in order — read what is linked, prove yourself, leave for the provider, come
 * back — and its requests should not be scattered among the factor surfaces.
 *
 * `verify` appears once per action, matching how every other multi-action route is
 * split here: the drift test prefix-matches on "METHOD /path — action".
 *
 * ─── The two entries worth noticing ────────────────────────────────────────
 *
 * `start` is the only request in this collection that REQUIRES `x-elevation-ticket`
 * — `POST /auth/link` is the only other route that takes one at all — and the ticket
 * lives sixty seconds, so anyone working through this folder by hand has to run
 * `verify` immediately before it rather than at the top of the session.
 *
 * `callback` returns no session, and that is the point of the whole folder rather than
 * an incidental fact: the superficially similar `POST /auth/login {step:'oauth-callback'}`
 * DOES mint one, so a reader who reached for the login route to do this would have
 * signed themselves in as whoever owns the provider account they were attaching.
 *
 * ─── `unlink` is last, and is not the end of the flow ──────────────────────
 *
 * It removes nothing. It records a deadline seven days out, and the link keeps working
 * — so a reader who runs it and then re-runs `GET` will still see the provider listed,
 * now carrying `unlinkAt`. That is the behaviour, not a stale read.
 *
 * It needs its own `verify` first, with `{"intent":"unlink"}`: the ticket `start` uses
 * is stamped `account.social.link` and is refused here. Running the two in the wrong
 * order is the mistake this folder's ordering is meant to prevent, which is why
 * `verify` appears twice.
 *
 * There is no `cancel` request because there is no cancel route — re-running
 * `start` + `callback` as the same provider account is what takes a pending removal back.
 */
const hasSocialAccounts = collection.item.some((folder) =>
  folder.name.startsWith('16. Social accounts'),
);
if (!hasSocialAccounts) {
  const simple = (name: string, method: string, path: string) => ({
    name,
    request: { method, header: [], url: `{{baseUrl}}${path}` },
  });
  const base = '/settings/security/social-accounts';
  collection.item.push({
    name: `16. Social accounts — ${base}`,
    item: [
      simple(`GET ${base}`, 'GET', base),
      simple(`POST ${base}/verify — challenge`, 'POST', `${base}/verify`),
      simple(`POST ${base}/verify — verify`, 'POST', `${base}/verify`),
      simple(`POST ${base}/start`, 'POST', `${base}/start`),
      simple(`POST ${base}/callback`, 'POST', `${base}/callback`),
      simple(`POST ${base}/verify — verify (intent: unlink)`, 'POST', `${base}/verify`),
      simple(`POST ${base}/unlink`, 'POST', `${base}/unlink`),
    ],
  });
}

/**
 * ═══ 17. DELETE ACCOUNT ═════════════════════════════════════════════════════
 *
 * Four requests, and the ordering matters more here than anywhere else in this
 * collection because running them takes the account away.
 *
 * ─── `delete` is not like `unlink` one folder up ───────────────────────────
 *
 * The social unlink records a deadline and changes nothing; a reader can run it and
 * carry on. This one takes effect immediately: it revokes EVERY session, including the
 * one the collection is using, so every request after it — in this folder and in every
 * other — answers 401 until the account is restored or a new one is made. That is the
 * behaviour, not a broken environment.
 *
 * `verify` must run immediately before it: the ticket lives sixty seconds, is stamped
 * `account.delete`, and no ticket from any other folder is accepted.
 *
 * ─── `reactivate` is the way back, and needs no session ────────────────────
 *
 * Which is why it still works after `delete` has signed the collection out. It takes
 * the account's email address and a code mailed to it — run `challenge`, read the
 * mailbox, then `verify`. Restoring does NOT sign the caller back in: no cookie is set
 * and no token is issued, so the last step of any manual run is an ordinary login.
 *
 * Its `challenge` answers identically for an address with an account and one without,
 * so a reader testing it with a made-up address gets the same 200 and should not read
 * that as the address being registered.
 */
const hasDeleteAccount = collection.item.some((folder) =>
  folder.name.startsWith('17. Delete account'),
);
if (!hasDeleteAccount) {
  const simple = (name: string, method: string, path: string) => ({
    name,
    request: { method, header: [], url: `{{baseUrl}}${path}` },
  });
  const base = '/settings/security/delete-account';
  collection.item.push({
    name: `17. Delete account — ${base}`,
    item: [
      simple(`GET ${base}`, 'GET', base),
      simple(`POST ${base}/verify — challenge`, 'POST', `${base}/verify`),
      simple(`POST ${base}/verify — verify`, 'POST', `${base}/verify`),
      simple(`POST ${base}`, 'POST', base),
      simple(`POST ${base}/reactivate — challenge`, 'POST', `${base}/reactivate`),
      simple(`POST ${base}/reactivate — verify`, 'POST', `${base}/reactivate`),
    ],
  });
}

writeFileSync(output, `${JSON.stringify(collection, null, 2)}\n`);
