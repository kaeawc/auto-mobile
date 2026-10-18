/**
 * CtrlProxyHierarchy - Delegate for hierarchy retrieval and caching.
 *
 * This delegate handles getting, caching, and converting view hierarchy data
 * from the Android accessibility service.
 */

import { logger } from "../../../utils/logger";
import type { HierarchyDelegateContext, CachedHierarchy } from "./types";

/** Cooldown after a WebSocket timeout before retrying fresh-data waits.
 *  Keep short: a long cooldown (e.g. 5s) turns a single slow response into
 *  a cascade where every hierarchy request returns stale data. */
export const WEBSOCKET_TIMEOUT_COOLDOWN_MS = 500;

/**
 * Check if we should skip WebSocket wait due to recent timeout.
 */
export function shouldSkipWebSocketWait(
  context: Pick<HierarchyDelegateContext, "getLastWebSocketTimeout" | "timer">,
): boolean {
  const lastTimeout = context.getLastWebSocketTimeout();
  if (lastTimeout === 0) {
    return false;
  }
  const timeSinceTimeout = context.timer.now() - lastTimeout;
  return timeSinceTimeout < WEBSOCKET_TIMEOUT_COOLDOWN_MS;
}

/**
 * Whether a device-stamped tree satisfies a caller's `minTimestamp` floor. A
 * caller with no floor, or a tree with no numeric stamp, is satisfied.
 */
export function satisfiesMinTimestamp(updatedAt: unknown, minTimestamp: number): boolean {
  if (minTimestamp <= 0 || typeof updatedAt !== "number" || Number.isNaN(updatedAt)) {
    return true;
  }
  if (updatedAt >= minTimestamp) {
    return true;
  }
  logger.warn(
    `[CTRL_PROXY] Sync returned a tree older than minTimestamp (updatedAt=${updatedAt}, minTimestamp=${minTimestamp}); reporting it stale`,
  );
  return false;
}

/**
 * Determine whether cached data satisfies a minTimestamp requirement.
 */
export function evaluateMinTimestamp(
  cachedHierarchy: CachedHierarchy,
  minTimestamp: number,
  useDeviceTimestamp: boolean,
): {
  isFresh: boolean;
  updatedAt?: number;
  updatedAfter: boolean;
  receivedAfter: boolean;
  usesUpdatedAt: boolean;
} {
  const updatedAt = cachedHierarchy.hierarchy.updatedAt;
  const hasUpdatedAt = typeof updatedAt === "number" && !Number.isNaN(updatedAt);
  const shouldUseUpdatedAt = useDeviceTimestamp && hasUpdatedAt;
  const updatedAfter = shouldUseUpdatedAt ? updatedAt >= minTimestamp : false;
  const receivedAfter = !shouldUseUpdatedAt ? cachedHierarchy.receivedAt >= minTimestamp : false;
  return {
    isFresh: shouldUseUpdatedAt ? updatedAfter : receivedAfter,
    updatedAt,
    updatedAfter,
    receivedAfter,
    usesUpdatedAt: shouldUseUpdatedAt,
  };
}
