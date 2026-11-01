/**
 * The country surface's typed failures.
 *
 * These exist so the layers that detect a problem — the image normaliser, the storage
 * adapter — can refuse without importing the HTTP envelope. `CountryService` is the one
 * place that turns them into a `ProblemException`, which keeps the wire contract in one
 * file and leaves the leaves testable without a request.
 *
 * The same arrangement as `WalletLogoInvalid` / `WalletLogoTooLarge` /
 * `WalletLogoStorageUnavailable` in src/wallet/core/wallet-core.errors.ts.
 */

/** The bytes are not an image this service will store. `message` reaches the caller. */
export class CountryImageInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountryImageInvalid';
  }
}

/** Over the byte ceiling, before or after normalisation. */
export class CountryImageTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountryImageTooLarge';
  }
}

/**
 * Storage could not be reached, or is not configured.
 *
 * Carries NO message on purpose — there is nothing a caller may safely be told. The
 * endpoint, bucket and SDK error are logged by the service and never serialised. A
 * default message here would be the thing that eventually leaks one.
 */
export class CountryImageStorageUnavailable extends Error {
  constructor() {
    super('Country image storage is unavailable.');
    this.name = 'CountryImageStorageUnavailable';
  }
}
