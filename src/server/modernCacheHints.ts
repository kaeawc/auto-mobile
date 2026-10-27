import type { McpServerOptions } from "@modelcontextprotocol/server";

/**
 * Cache hints on modern-era results (#13947). Always `private`: `tools/list` is filtered per
 * session key, so a shared cache could serve one caller another's catalog. The TTL is short because
 * a modern client has no list-changed stream until `subscriptions/listen` is wired.
 */
export const MODERN_CACHE_HINTS = {
  "tools/list": { ttlMs: 30_000, cacheScope: "private" },
  "server/discover": { ttlMs: 60_000, cacheScope: "private" },
} as const satisfies NonNullable<McpServerOptions["cacheHints"]>;
