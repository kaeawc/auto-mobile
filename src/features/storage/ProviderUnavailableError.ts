/** Stable resource error fields for an absent AutoMobile SDK provider. */
export class ProviderUnavailableError extends Error {
  readonly errorCode = "PROVIDER_UNAVAILABLE";
  readonly errorReason = "sdk_provider_absent";

  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** Keep the free-text error and add machine-readable fields when known. */
export function resourceErrorFields(error: unknown): {
  errorCode?: string;
  errorReason?: string;
} {
  return error instanceof ProviderUnavailableError
    ? { errorCode: error.errorCode, errorReason: error.errorReason }
    : {};
}
