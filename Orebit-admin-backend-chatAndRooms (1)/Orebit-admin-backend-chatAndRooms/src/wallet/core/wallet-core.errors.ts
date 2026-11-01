export type WalletErrorCode =
  | 'wallet_configuration_conflict'
  | 'wallet_configuration_invalid'
  | 'wallet_preference_invalid'
  | 'wallet_provider_unavailable'
  | 'wallet_logo_invalid'
  | 'wallet_logo_too_large'
  | 'wallet_logo_storage_unavailable'
  | 'wallet_authorization_unavailable';

/** Base for expected Wallet failures handled by the module-local exception filter. */
export abstract class WalletDomainError extends Error {
  protected constructor(
    readonly code: WalletErrorCode,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = new.target.name;
  }
}

/** Expected client-correctable Wallet failures may expose only caller-supplied safe detail. */
export abstract class WalletValidationError extends WalletDomainError {
  protected constructor(
    code: WalletErrorCode,
    status: number,
    title: string,
    readonly detail?: string,
  ) {
    super(code, status, title);
  }
}

export class WalletConfigurationConflict extends WalletDomainError {
  constructor(readonly actualRevision: number) {
    super('wallet_configuration_conflict', 409, 'Wallet configuration revision conflict');
  }
}

export class WalletConfigurationInvalid extends WalletValidationError {
  constructor(detail?: string) {
    super('wallet_configuration_invalid', 400, 'Invalid Wallet configuration', detail);
  }
}

export class WalletPreferenceInvalid extends WalletValidationError {
  constructor(detail?: string) {
    super('wallet_preference_invalid', 400, 'Invalid Wallet preference', detail);
  }
}

export class WalletProviderUnavailable extends WalletDomainError {
  constructor() {
    super('wallet_provider_unavailable', 503, 'Wallet provider unavailable');
  }
}

export class WalletLogoInvalid extends WalletValidationError {
  constructor(detail?: string) {
    super('wallet_logo_invalid', 400, 'Invalid Wallet logo', detail);
  }
}

export class WalletLogoTooLarge extends WalletValidationError {
  constructor(detail?: string) {
    super('wallet_logo_too_large', 413, 'Wallet logo too large', detail);
  }
}

export class WalletLogoStorageUnavailable extends WalletDomainError {
  constructor() {
    super('wallet_logo_storage_unavailable', 503, 'Wallet logo storage unavailable');
  }
}

export class WalletAuthorizationUnavailable extends WalletDomainError {
  constructor() {
    super('wallet_authorization_unavailable', 403, 'Wallet authorization unavailable');
  }
}
