import { ActionableError } from "./ActionableError";
import type { Platform } from "./Platform";
import type { EmulatorLossIncident } from "../daemon/emulatorLossIncident";

export interface SessionRecoveryAssignmentDetails {
  sessionUuid: string;
  platform: Platform;
  deviceId: string;
  stableDeviceId: string;
  incidentId?: string;
  detectionPath?: EmulatorLossIncident["detectionPath"];
  processExit?: EmulatorLossIncident["processExit"];
  recoveryOutcome?: EmulatorLossIncident["recovery"]["outcome"];
  retry: { sameSession: true };
  recoveryWindowRemainingMs: number;
  fallback: {
    action: "acquire_replacement_session";
    tools: ["getAndroid", "getApple"];
  };
}

/** An unavailable restart target whose existing session can still resume. */
export class SessionRecoveryAssignmentError extends ActionableError {
  constructor(readonly details: SessionRecoveryAssignmentDetails) {
    const incidentContext = details.incidentId
      ? `Loss incident ${details.incidentId}: ${details.detectionPath}` +
        (details.processExit
          ? ` (code=${details.processExit.code}, signal=${details.processExit.signal})`
          : "") +
        `; recovery outcome: ${details.recoveryOutcome}. `
      : "";
    super(
      `Cannot safely recover session ${details.sessionUuid}: ${details.platform} device ` +
        `'${details.stableDeviceId}' is unavailable or already in use. ` +
        incidentContext +
        "The session can still resume if the device returns before the recovery window ends " +
        `(${Math.ceil(details.recoveryWindowRemainingMs / 1000)} seconds remaining); ` +
        `otherwise acquire a new device with ${details.fallback.tools.join(" or ")}.`,
    );
  }
}
