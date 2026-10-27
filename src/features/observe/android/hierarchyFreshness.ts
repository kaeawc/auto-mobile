import { logger } from "../../../utils/logger";
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
