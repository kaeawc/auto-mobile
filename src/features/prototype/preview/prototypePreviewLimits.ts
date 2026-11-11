/**
 * Preview server limits (#17975), apart from the server so the tool schema can name them without
 * loading node:http at startup.
 */

/** Idle time after which a server with no open page and no request or change stops itself. */
export const DEFAULT_PROTOTYPE_PREVIEW_IDLE_TIMEOUT_MS = 30 * 60_000;
export const MAX_PROTOTYPE_PREVIEW_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;
