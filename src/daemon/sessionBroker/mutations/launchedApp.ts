import { logger } from "../../../utils/logger";
import type { DeviceMutationInput } from "./types";

const LAUNCHED_APP = "launched-app";

/**
 * Key of the non-fallback `opaque` row an Android app launch journals (`launchApp`,
 * `measureStartup`). It claims no revert: Android keep-booted cleaning reads it to `pm clear` a
 * preinstalled app the session started, whose data the package inventory clean never touches.
 */
export function launchedAppIntentKey(appId: string): string {
  return JSON.stringify([LAUNCHED_APP, appId]);
}

/** The app a launch row names, null for a malformed launch row, undefined for any other row. */
export function launchedAppId(
  entry: Pick<DeviceMutationInput, "kind" | "key">,
): string | null | undefined {
  if (entry.kind !== "opaque" || !entry.key.startsWith(`["${LAUNCHED_APP}"`)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(entry.key);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed[0] === LAUNCHED_APP &&
      typeof parsed[1] === "string"
      ? parsed[1]
      : null;
  } catch (error) {
    logger.warn("Launched-app journal key is unreadable; baseline fallback required", error);
    return null;
  }
}
