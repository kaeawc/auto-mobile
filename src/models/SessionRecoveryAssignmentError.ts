import { ActionableError } from "./ActionableError";
import type { Platform } from "./Platform";
import { DEVICE_SESSION_RECOVERY_TOOLS } from "./deviceSessionRecovery";

/** Incident fields needed by recovery guidance, independent of the daemon store. */
export interface SessionRecoveryIncidentContext {
  incidentId?: string;
  detectionPath?: string;
  processExit?: { code: number | null; signal: NodeJS.Signals | null };
  recoveryOutcome?: string;
}

/** Preserve the incident prose shared by in-window and expired recovery failures. */
export function formatSessionRecoveryIncidentContext(
  details: SessionRecoveryIncidentContext,
): string {
  return details.incidentId
    ? `Loss incident ${details.incidentId}: ${details.detectionPath}` +
        (details.processExit
          ? ` (code=${details.processExit.code}, signal=${details.processExit.signal})`
          : "") +
        `; recovery outcome: ${details.recoveryOutcome}. `
    : "";
}

export interface SessionRecoveryAssignmentDetails extends SessionRecoveryIncidentContext {
  code: "session_recovery_pending";
  sessionUuid: string;
  platform: Platform;
  deviceId: string;
  stableDeviceId: string;
  retryable: true;
  /** Retry the same sessionUuid while this recovery window remains open. */
  recoveryWindowRemainingMs: number;
  recovery: {
    action: "acquire_replacement_session";
    tools: typeof DEVICE_SESSION_RECOVERY_TOOLS;
  };
}

/** An unavailable restart target whose existing session can still resume. */
export class SessionRecoveryAssignmentError extends ActionableError {
  readonly details: SessionRecoveryAssignmentDetails;

  constructor(details: Omit<SessionRecoveryAssignmentDetails, "code" | "retryable" | "recovery">) {
    super(
      `Cannot safely recover session ${details.sessionUuid}: ${details.platform} device ` +
        `'${details.stableDeviceId}' is unavailable or already in use. ` +
        formatSessionRecoveryIncidentContext(details) +
        "The session can still resume if the device returns before the recovery window ends " +
        `(${Math.ceil(details.recoveryWindowRemainingMs / 1000)} seconds remaining); ` +
        `otherwise acquire a new device with ${DEVICE_SESSION_RECOVERY_TOOLS.join(" or ")}.`,
    );
    this.name = "SessionRecoveryAssignmentError";
    this.details = {
      ...details,
      code: "session_recovery_pending",
      retryable: true,
      recovery: { action: "acquire_replacement_session", tools: DEVICE_SESSION_RECOVERY_TOOLS },
    };
  }
}
