import { Injectable } from '@nestjs/common';
import type { GeoLookup, GeoResolver } from './geo.types';

/**
 * STUB. Returns the IP it was given and `country: null`, always.
 *
 * Note what is *not* stubbed: the IP itself is still captured and stored — on
 * `Registration.ipAddress` and as `Session.ipClass`. Only the country lookup is
 * absent. That distinction is what lets a provider be added later without a
 * backfill: the addresses are on record from the first signup, so history is not
 * lost, and the "commonly used country" derivation the founder's spec eventually
 * wants has data to work from.
 *
 * Consequence today: `countrySuggested` on the registration state is always
 * null, so the country dropdown opens unselected.
 *
 * Replacing it: implement `GeoResolver` against whichever provider is chosen,
 * rebind GEO_RESOLVER in geo.module.ts. Whatever it is, it must keep the port's
 * contract — never throw, and return null rather than a guess.
 */
@Injectable()
export class NullGeoResolver implements GeoResolver {
  async resolve(ip: string): Promise<GeoLookup> {
    return { ip, country: null };
  }
}
