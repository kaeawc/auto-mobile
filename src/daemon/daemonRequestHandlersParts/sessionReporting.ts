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
    await lookupReleasedSessionEnd(manager, sessionId),
    daemonInstance,
  );
}

/** How a released UUID ended: its reason and, for `cli-idle-timeout`, its idle window (#16937). */
export interface ReleasedSessionEnd {
  releaseReason: string | undefined;
  idleTimeoutMs?: number;
}

export function notFoundResult(
  sessionId: string,
  end: ReleasedSessionEnd,
  daemonInstance?: string,
): DaemonMethodResult {
  return {
    success: false,
    error: `Session not found: ${sessionId}`,
    code: DAEMON_SESSION_NOT_FOUND_CODE,
    ...releasedSessionNotFoundFields(end.releaseReason, end.idleTimeoutMs),
    ...(daemonInstance !== undefined ? { daemonInstance } : {}),
  };
}

/** The recorded end of a UUID (best-effort): its reason, plus the CLI window for a cli-idle end. */
export async function lookupReleasedSessionEnd(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
): Promise<ReleasedSessionEnd> {
  const releaseReason = await lookupReleasedSessionReason(manager, sessionId);
  const idleTimeoutMs = await lookupReleasedSessionIdleTimeoutMs(manager, sessionId, releaseReason);
  return idleTimeoutMs === undefined ? { releaseReason } : { releaseReason, idleTimeoutMs };
}

/**
 * The CLI idle window of a UUID released as `cli-idle-timeout` (#16937), or undefined for any
 * other reason, an unknown window, or a failed lookup (best-effort, like the reason).
 */
export async function lookupReleasedSessionIdleTimeoutMs(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  releaseReason: string | undefined,
): Promise<number | undefined> {
  if (releaseReason !== "cli-idle-timeout") {
    return undefined;
  }
  try {
    return await manager.getReleasedSessionIdleTimeoutMs?.(sessionId);
  } catch (error) {
    logger.warn(`Idle window lookup failed for ${sessionId}: ${errorMessage(error)}`, error);
    return undefined;
  }
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
