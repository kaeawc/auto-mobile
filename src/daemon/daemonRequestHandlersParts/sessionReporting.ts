import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { DAEMON_SESSION_NOT_FOUND_CODE, releasedSessionNotFoundFields } from "../types";
import type { DaemonStateAccess, DaemonMethodResult } from "./contracts";

/** A session-clock instant as wall-clock epoch ms, for a report another process reads (#11105). */
export function reportedWallClock(
  manager: {
    sessionClockToWall?(sessionClockMs: number): number;
    sessionClockToReportedWall?(sessionClockMs: number): number;
  },
  sessionClockMs: number,
): number {
  return (
    manager.sessionClockToReportedWall?.(sessionClockMs) ??
    manager.sessionClockToWall?.(sessionClockMs) ??
    sessionClockMs
  );
}

/**
 * Session-not-found answer. A session the daemon knows it released also says why
 * (`releaseReason`, #10730; `idle: true` for an idle-window release, #10832) so a client can tell
 * an idle release from a restart or lapsed owner;
 * a UUID the daemon never issued stays a plain not-found.
 */
export async function sessionNotFoundResult(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  daemonInstance?: string,
): Promise<DaemonMethodResult> {
  return notFoundResult(
    sessionId,
    await lookupReleasedSessionReason(manager, sessionId),
    daemonInstance,
  );
}

export function notFoundResult(
  sessionId: string,
  releaseReason: string | undefined,
  daemonInstance?: string,
): DaemonMethodResult {
  return {
    success: false,
    error: `Session not found: ${sessionId}`,
    code: DAEMON_SESSION_NOT_FOUND_CODE,
    ...releasedSessionNotFoundFields(releaseReason),
    ...(daemonInstance !== undefined ? { daemonInstance } : {}),
  };
}

/** The recorded release reason, or undefined when unknown or the lookup fails (best-effort). */
export async function lookupReleasedSessionReason(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
): Promise<string | undefined> {
  try {
    return await manager.getReleasedSessionReason?.(sessionId);
  } catch (error) {
    logger.warn(`Release reason lookup failed for ${sessionId}: ${errorMessage(error)}`, error);
    return undefined;
  }
}
