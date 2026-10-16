/**
 * Limits for the prototype `request` action (#12518). One module so the spec contract (#12523)
 * and the host executor (#12527) cannot drift apart.
 */
export const DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_PROTOTYPE_REQUEST_TIMEOUT_MS = 30_000;
/** Largest response body the host reads; a larger body fails with `too_large`. */
export const MAX_PROTOTYPE_RESPONSE_BYTES = 256 * 1024;
/** Concurrent host-proxied requests per device. */
export const MAX_PROTOTYPE_REQUESTS_IN_FLIGHT = 4;
