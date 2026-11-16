/** Default wall-clock limit for one buildApp run. */
export const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60_000;

/**
 * Largest timeoutMs a caller may pass: the daemon request budget adds headroom on top and is
 * capped at 30 minutes, so a longer build would outlive the request that waits for it.
 */
export const MAX_BUILD_TIMEOUT_MS = 28 * 60_000;

/** Request headroom beyond the build itself: the build-settings read and the response. */
export const BUILD_APP_MCP_TIMEOUT_HEADROOM_MS = 120_000;
