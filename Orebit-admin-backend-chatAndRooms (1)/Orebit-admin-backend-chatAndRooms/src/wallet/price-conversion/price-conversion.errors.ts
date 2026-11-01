/** Carries the authoritative revision for a stable optimistic-concurrency 409 response. */
export class PriceConfigurationConflict extends Error {
  readonly code = 'price_configuration_conflict';
  readonly status = 409;
  constructor(readonly actualRevision: number) {
    super('Price configuration revision conflict');
  }
}

/** Marks a stable client-correctable configuration validation failure. */
export class PriceConfigurationValidationError extends Error {
  readonly code = 'price_configuration_invalid';
  readonly status = 400;
  constructor(message: string) {
    super(message);
  }
}
