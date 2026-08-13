export const DEFAULT_DEVICE_READY_TIMEOUT_MS = 120000;
// Node timers clamp larger delays to 1ms. Reserve 5s for the daemon transport
// cleanup budget while keeping the complete request within the timer ceiling.
export const MAX_DEVICE_READY_TIMEOUT_MS = 2_147_483_647 - 5_000;
