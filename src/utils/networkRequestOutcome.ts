/**
 * Both SDKs stamp `error = "mocked:<mockId>"` on a response served by a `mockNetwork` rule.
 * The marker records provenance only; the mocked status code decides success or failure.
 * Older SDK builds keep sending it, so the host must tolerate it indefinitely.
 */
export const MOCKED_NETWORK_ERROR_PREFIX = "mocked:";

/** True when `error` records a transport failure rather than being absent or a mock marker. */
export function hasNetworkTransportError(error: string | null | undefined): boolean {
  const text = error?.trim();
  return Boolean(text) && !text?.startsWith(MOCKED_NETWORK_ERROR_PREFIX);
}

/** Classify captured requests independently of the platform that recorded them. */
export function isFailedNetworkRequest(request: {
  statusCode?: number | null;
  error?: string | null;
}): boolean {
  const { statusCode, error } = request;
  return (
    hasNetworkTransportError(error) ||
    typeof statusCode !== "number" ||
    !Number.isFinite(statusCode) ||
    statusCode <= 0 ||
    statusCode >= 400
  );
}
