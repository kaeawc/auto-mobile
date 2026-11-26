import type { NonIosApplePlatform } from "../../models/Platform";
import { DaemonBoundSessionExpiredError } from "./DaemonBoundSessionExpiredError";
import { DaemonConnectionSessionReleasedError } from "./DaemonConnectionSessionReleasedError";
import { DaemonSessionStalledError } from "./DaemonSessionStalledError";

/**
 * Name a lost watchOS, tvOS or visionOS session's platform on its ownership-loss error (#19186)
 * or its connection's no-active-session error (#19234), so the recovery prose names startDevice
 * rather than getAndroid/getApple, which refuse it. A stall handover keeps its own typed answer;
 * any other error passes through unchanged.
 */
export function withLostSessionPlatform(
  error: unknown,
  sessionApplePlatforms: ReadonlyMap<string, NonIosApplePlatform>,
): unknown {
  if (error instanceof DaemonConnectionSessionReleasedError) {
    const platform =
      error.sessionUuid === undefined ? undefined : sessionApplePlatforms.get(error.sessionUuid);
    return platform === undefined ? error : error.forPlatform(platform);
  }
  if (
    !(error instanceof DaemonBoundSessionExpiredError) ||
    error instanceof DaemonSessionStalledError
  ) {
    return error;
  }
  const platform = sessionApplePlatforms.get(error.sessionUuid);
  return platform === undefined ? error : error.forPlatform(platform);
}
