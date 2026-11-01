/**
 * The geo/IP port.
 *
 * Its job in this iteration is narrow: give the registration's country step a
 * sensible default to preselect. Nothing gates on the result, so a null country
 * degrades the UX by one dropdown interaction and nothing more.
 *
 * Keeping it a port rather than a direct call matters for a reason beyond
 * tidiness — the eventual implementation fans out to several third-party
 * providers and takes a consensus, and that is not something callers should ever
 * see. They ask for a country and get one, or don't.
 */

export interface GeoLookup {
  readonly ip: string;
  /** ISO 3166-1 alpha-2, uppercase. Null when unknown — never guessed. */
  readonly country: string | null;
}

export interface GeoResolver {
  /** Never throws and never rejects: a failed lookup is `country: null`. A
   *  signup must not fail because a geo provider timed out. */
  resolve(ip: string): Promise<GeoLookup>;
}

export const GEO_RESOLVER = Symbol('GEO_RESOLVER');
