import type { McpServerOptions } from "@modelcontextprotocol/server";

/**
 * Cache hints on modern-era results (#13947). Always `private`: `tools/list` is filtered per
 * session key, so a shared cache could serve one caller another's catalog. The short TTL (5s)
 * also bounds staleness for modern clients that do not open `subscriptions/listen`.
 */
export const MODERN_CACHE_HINTS = {
  "tools/list": { ttlMs: 5_000, cacheScope: "private" },
  "server/discover": { ttlMs: 60_000, cacheScope: "private" },
} as const satisfies NonNullable<McpServerOptions["cacheHints"]>;
