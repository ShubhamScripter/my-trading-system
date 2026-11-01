/**
 * ═══ THE RESTRICTION CATALOGUE ══════════════════════════════════════════════
 *
 * Four registries and the tables that relate them. Nothing here does I/O, holds
 * state, or decides anything — it is the vocabulary every other file in
 * `src/restrictions/` is written against, and the single place a reviewer can read
 * "what can trigger a restriction, and what can be restricted".
 *
 * The shape is `ELEVATION_ACTIONS` / `ADMIN_ELEVATION`'s, deliberately: a frozen
 * `as const` tuple, a derived union type, a type guard, and `Readonly<Record<…>>`
 * lookup tables rather than switch cases. `Orebit-admin-backend/src/admins/
 * admins.types.ts` gives the reason, and it is the reason here too — "what does this
 * action require" is a security property, and a security property spread across
 * switch statements is one a reviewer has to reconstruct.
 */

// ─── the trigger actions ────────────────────────────────────────────────────

/**
 * The sensitive actions that may create a restriction when they SUCCEED.
 *
 * Dotted and namespaced, matching `ELEVATION_ACTIONS` in src/2fa/elevation.ts, so a
 * value read out of a database row or a log line is unambiguous about which feature
 * it belongs to.
 *
 * ─── This list is deliberately shorter than the settings surface ───────────
 *
 * `src/settings/` has seventeen mutating actions and eight of them are here. The
 * omissions are not oversights and each has a reason:
 *
 *   Passkey ADD, authenticator ENABLE, payment-PIN ENABLE — these STRENGTHEN an
 *     account. Restricting a user for improving their security would teach them not
 *     to.
 *   Username update, anti-phishing set/change, social link/unlink — not security
 *     credentials in the sense this feature is about. None of them is a way into the
 *     account, so none of them is worth taking a feature away over.
 *   Account deletion — the account is already locked and every session revoked;
 *     there is nothing left to restrict.
 *
 * Adding a member here is a product decision, not a refactor.
 */
export const TRIGGER_ACTIONS = [
  'password.change',
  'email.update',
  /**
   * ─── INERT. There is no phone feature in this backend ────────────────────
   *
   * No column, no table, no route, no service, no migration — see the note in
   * auth/services/recent-security-change.policy.ts, which says the same thing about
   * the security cooldown and refuses to stub anything to make its list look
   * complete.
   *
   * These two are here anyway, and that is a decision rather than an accident: the
   * policy rows are Admin-configurable now, so an operator can set them up before the
   * feature exists, and nothing has to be re-typed or re-migrated on the day it does.
   * Until then nothing ever emits them and no code path can reach them.
   */
  'phone.update',
  'phone.remove',
  'passkey.remove',
  'authenticator.remove',
  'paymentPin.update',
  'paymentPin.remove',
] as const;

export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

export function isTriggerAction(value: string): value is TriggerAction {
  return (TRIGGER_ACTIONS as readonly string[]).includes(value);
}

/**
 * The trigger actions that are reachable today.
 *
 * `TRIGGER_ACTIONS` minus the two phone entries. Exported so a test can assert that
 * every reachable action has a seam wired to it, without that test also failing for
 * the two that deliberately have none — which is the difference between "not built
 * yet" and "forgotten".
 */
export const LIVE_TRIGGER_ACTIONS = TRIGGER_ACTIONS.filter(
  (action) => action !== 'phone.update' && action !== 'phone.remove',
) as readonly TriggerAction[];

// ─── the two configurable contexts, and the three classifications ───────────

/**
 * The security contexts an Admin configures a policy FOR. Exactly two, so the policy
 * table holds `TRIGGER_ACTIONS.length * POLICY_CONTEXTS.length` rows and no more.
 */
export const POLICY_CONTEXTS = ['COMMON_IP_DEVICE', 'NEW_CONTEXT'] as const;

export type PolicyContext = (typeof POLICY_CONTEXTS)[number];

export function isPolicyContext(value: string): value is PolicyContext {
  return (POLICY_CONTEXTS as readonly string[]).includes(value);
}

/**
 * What the evaluator can conclude about a request. THREE values, not two.
 *
 * ═══ WHY THIS IS A WIDER SET THAN `POLICY_CONTEXTS` ════════════════════════
 *
 * The two configurable contexts are not exhaustive, and pretending otherwise is the
 * bug this type exists to prevent. With the agreed rules —
 *
 *   A  =  !isNewIp && !isNewDevice
 *   B  =   isNewIp && (isNewCountry || isNewDevice)
 *
 * — a request with a known IP and a new device matches neither, and so does one with
 * a new IP, a known device and no country signal. Those are not rare edge cases;
 * with `NullGeoResolver` bound they are most of the interesting traffic.
 *
 * A request that matches neither is `UNCLASSIFIED`. It is RECORDED as such, and it
 * has `NEW_CONTEXT`'s policy APPLIED to it — see `POLICY_FOR_CLASSIFICATION`. Those
 * two facts have to be separable, because collapsing them at the point of decision
 * would make the restriction row claim the evaluator was confident when it was not,
 * and there would then be no way to measure how often the fail-safe path is taken.
 */
export const CLASSIFICATIONS = ['COMMON_IP_DEVICE', 'NEW_CONTEXT', 'UNCLASSIFIED'] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export function isClassification(value: string): value is Classification {
  return (CLASSIFICATIONS as readonly string[]).includes(value);
}

/**
 * Which configured policy each classification resolves to.
 *
 * A TABLE rather than `classification === 'COMMON_IP_DEVICE' ? … : …`, so the
 * fail-safe rule is something a reviewer reads rather than something they infer from
 * a ternary. `UNCLASSIFIED` mapping to `NEW_CONTEXT` IS the fail-safe rule, and it is
 * the one line in this file most worth getting wrong-proof: inverting it would make
 * every unclassifiable request take the lenient policy, silently, with no test
 * failing and no log line looking unusual.
 */
export const POLICY_FOR_CLASSIFICATION: Readonly<Record<Classification, PolicyContext>> = {
  COMMON_IP_DEVICE: 'COMMON_IP_DEVICE',
  NEW_CONTEXT: 'NEW_CONTEXT',
  UNCLASSIFIED: 'NEW_CONTEXT',
};

// ─── the feature hierarchy ──────────────────────────────────────────────────

/**
 * ═══ EMPTY ON PURPOSE — THE PRODUCT HIERARCHY HAS NOT BEEN SUPPLIED ═════════
 *
 * This is the registry of platform features and the sub-features under each. It is
 * `{}` because nobody has said what the features ARE, and inventing plausible ones
 * would be worse than leaving it empty in a way that is easy to miss: a name invented
 * here would be written into policy rows by an operator, into restriction rows by the
 * engine, and into an Admin UI, and every one of those would have to be migrated when
 * the real name arrived.
 *
 * ─── What being empty actually does, and why it is safe ───────────────────
 *
 * Everything downstream already handles an unknown feature name by DROPPING it with a
 * warning — the discipline `CaptchaSettingsService.refresh` uses for unknown provider
 * names, for the same reason. With this registry empty, every name is unknown, so
 * every policy row resolves to an empty feature set, so `planFor` produces no rows and
 * no restriction is ever created.
 *
 * That is exactly the safe state, and it falls out of the existing rule rather than
 * needing a special case. The engine is fully exercisable in tests — which supply
 * their own registry — while remaining inert in production until this is filled in.
 *
 * ─── Filling it in ────────────────────────────────────────────────────────
 *
 * Replace `{}` with the real hierarchy, keyed feature id → its sub-feature ids:
 *
 *   export const PLATFORM_FEATURES = {
 *     <featureId>: ['<subFeatureId>', '<subFeatureId>'],
 *   } as const satisfies FeatureHierarchy;
 *
 * Nothing else in this file or any other has to change — the types below are derived,
 * and the guards read the object at runtime. A feature with no sub-features takes an
 * empty array and is restrictable only as a whole.
 *
 * Ids are opaque strings compared exactly. They are stored in the database as written
 * here, so renaming one is a data migration, not an edit.
 */
export type FeatureHierarchy = Readonly<Record<string, readonly string[]>>;

export const PLATFORM_FEATURES = {} as const satisfies FeatureHierarchy;

/** Every feature id, in declaration order. Empty until the hierarchy is supplied. */
export function featureIds(hierarchy: FeatureHierarchy = PLATFORM_FEATURES): readonly string[] {
  return Object.keys(hierarchy);
}

/**
 * True for a feature id the registry knows.
 *
 * `hasOwnProperty` rather than `value in hierarchy` or a `!== undefined` check on the
 * lookup. Feature ids arrive from a database column an operator wrote, so they are
 * attacker-adjacent strings, and every object inherits `constructor`, `toString`,
 * `valueOf` and friends from `Object.prototype`. Either of the looser tests would
 * report those as real features — which would make them storable, matchable feature
 * ids that no Admin ever configured.
 */
export function isFeature(
  value: string,
  hierarchy: FeatureHierarchy = PLATFORM_FEATURES,
): boolean {
  return Object.prototype.hasOwnProperty.call(hierarchy, value);
}

/**
 * The sub-feature ids under one feature, or `[]` for an unknown feature.
 *
 * Routed through `isFeature` rather than `hierarchy[feature] ?? []`, and that is not
 * defensive habit — the `??` form returns `Object.prototype.valueOf` for the feature
 * id `"valueOf"`, so an unknown name yields a FUNCTION where every caller expects an
 * array. Going through the guard makes the two functions agree about what a feature is
 * by construction rather than by both remembering the same rule.
 */
export function subFeatureIds(
  feature: string,
  hierarchy: FeatureHierarchy = PLATFORM_FEATURES,
): readonly string[] {
  return isFeature(feature, hierarchy) ? (hierarchy[feature] ?? []) : [];
}

/**
 * True when `subFeature` is declared UNDER `feature`.
 *
 * Both arguments, never the sub-feature alone. Two features may legitimately name a
 * sub-feature the same thing, so a bare sub-feature id does not identify anything —
 * and a validator that accepted one would let an operator restrict a sub-feature of a
 * feature they did not select.
 */
export function isSubFeatureOf(
  feature: string,
  subFeature: string,
  hierarchy: FeatureHierarchy = PLATFORM_FEATURES,
): boolean {
  return subFeatureIds(feature, hierarchy).includes(subFeature);
}

/**
 * The hierarchy as a flat list of `{ feature, subFeature }` pairs, with
 * `subFeature: null` for each feature itself.
 *
 * This is the shape an Admin configuration screen needs — one call gives it every
 * selectable box — and the shape `GET /settings/security/restrictions` echoes. Built
 * here rather than in either caller so there is one answer to "what is selectable".
 */
export function selectableTargets(
  hierarchy: FeatureHierarchy = PLATFORM_FEATURES,
): readonly { readonly feature: string; readonly subFeature: string | null }[] {
  return featureIds(hierarchy).flatMap((feature) => [
    { feature, subFeature: null },
    ...subFeatureIds(feature, hierarchy).map((subFeature) => ({ feature, subFeature })),
  ]);
}
