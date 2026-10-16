import {
  isDeviceRestartReleaseReason,
  isRecoverableDeviceSession,
  persistedSessionExpiryReason,
} from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";

export type SessionLiveness = "live" | "recoverable-handoff" | "gone";

export interface SessionDispositionDependencies {
  isLive(sessionUuid: string): boolean;
  getSession(sessionUuid: string): Promise<DeviceSession | undefined>;
  timer: Pick<Timer, "now">;
}

/** A missing live-map entry is not terminal while its durable restart identity can resume. */
export async function sessionDisposition(
  sessionUuid: string,
  dependencies: SessionDispositionDependencies,
): Promise<SessionLiveness> {
  if (dependencies.isLive(sessionUuid)) {
    return "live";
  }
  try {
    const row = await dependencies.getSession(sessionUuid);
    const now = dependencies.timer.now();
    return row &&
      row.status === "released" &&
      row.release_reason &&
      isDeviceRestartReleaseReason(row.release_reason) &&
      row.released_at_ms !== null &&
      persistedSessionExpiryReason(row, now) === undefined &&
      isRecoverableDeviceSession(row, now)
      ? "recoverable-handoff"
      : "gone";
  } catch (error) {
    // A read failure is not proof of loss. Preserve ownership for a later recovery sweep.
    logger.warn(`Session ${sessionUuid} disposition lookup failed: ${errorMessage(error)}`, error);
    return "recoverable-handoff";
  }
}
