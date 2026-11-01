import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import {
  countryCreateSchema,
  countryImageQuerySchema,
  countryImageUploadSchema,
  countryQuerySchema,
  type CountriesPayload,
  type CountryImagesPayload,
} from './country.dto';
import type { CountryImageMultipart } from './country.multipart';
import { CountryService } from './country.service';
import type { CountryImageAsset, CountryView } from './country.types';

/**
 * Parse, delegate, serialise. No business logic and no authorisation.
 *
 * The gate is DECLARED on the route — `@UseGuards(SuperAdminGuard)` — rather than
 * checked here, because what this surface requires does not depend on the body. That is
 * the split `SecurityPolicyController` makes, and the opposite of `AdminsController`,
 * which authorises in the controller precisely because its requirement varies with the
 * parsed action.
 */
@Injectable()
export class CountryController {
  constructor(private readonly service: CountryService) {}

  /** The image library. Object storage only — no country records are read. */
  async listImages(query: unknown): Promise<SuccessEnvelope<CountryImagesPayload>> {
    const filter = parseDto(countryImageQuerySchema, query);
    return ok(await this.service.listImages(filter));
  }

  /** The catalogue. Database only — no bucket is read. */
  async list(query: unknown): Promise<SuccessEnvelope<CountriesPayload>> {
    const input = parseDto(countryQuerySchema, query);
    return ok(await this.service.list(input.isoCode));
  }

  async create(
    body: unknown,
    actor: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<CountryView>> {
    const input = parseDto(countryCreateSchema, body);
    return ok(await this.service.create(input, actor, client));
  }

  /**
   * The ISO code and the image type arrive as multipart FIELDS, so they are parsed here
   * rather than by a body schema — but through `countryImageUploadSchema`, which wraps
   * the same `countryCodeSchema` the create body and both query strings use.
   *
   * That shared schema is what makes the derived object key safe: it uppercases and
   * validates before the service ever mints `country-assets/{ISO}/{type}/{uuid}.webp`,
   * so no route can introduce a code shape the others would not accept.
   */
  async uploadImage(
    upload: CountryImageMultipart,
    actor: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<CountryImageAsset>> {
    const { isoCode, type } = parseDto(countryImageUploadSchema, upload.fields);
    return ok(await this.service.uploadImage(isoCode, type, upload.image, actor, client));
  }
}
