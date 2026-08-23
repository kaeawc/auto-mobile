import {
  DeviceLostError,
  DEVICE_LOSS_OUTCOME_CODE,
  type EmulatorLossIncident,
} from "../daemon/emulatorLossIncident";

export { DeviceLostError, DEVICE_LOSS_OUTCOME_CODE };
const deviceLossAbortErrors = new WeakMap<AbortSignal, DeviceLostError>();

export interface DeviceLossOutcome {
  code: typeof DEVICE_LOSS_OUTCOME_CODE;
  deviceId: string;
  sessionUuid?: string;
  incidentId?: string;
  reason: "confirmed-unavailable";
  detectionPath?: EmulatorLossIncident["detectionPath"];
  avdName?: string;
  replacementDeviceId?: string;
  sessionState?: "recovering" | "active" | "released";
  heartbeat?: {
    lastHeartbeatMs: number;
    hasReceivedHeartbeat: boolean;
    timeoutMs: number;
  };
  recovery?: {
    status: "pending" | "recovered" | "exhausted" | "not-attempted";
    attempts: number;
  };
  retry?: {
    sameSession: boolean;
    requiresNewSession: boolean;
  };
}

export function isDeviceLostError(error: unknown): error is DeviceLostError {
  return error instanceof DeviceLostError;
}

export function deviceLostErrorFromCancellationReason(reason: string): DeviceLostError | undefined {
  if (!reason.startsWith("device-disconnected:")) {
    return undefined;
  }
  const details = reason.slice("device-disconnected:".length);
  const incidentDelimiter = ";incident=";
  const incidentIndex = details.indexOf(incidentDelimiter);
  const deviceId = incidentIndex === -1 ? details : details.slice(0, incidentIndex);
  const incidentId = incidentIndex === -1
    ? undefined
    : details.slice(incidentIndex + incidentDelimiter.length) || undefined;
  return deviceId ? new DeviceLostError(deviceId, reason, incidentId) : undefined;
}

/**
 * Bun can report an aborted signal while temporarily hiding `signal.reason`.
 * Keep the typed reason out of the runtime-owned signal object so downstream
 * cancellation checks retain the infrastructure outcome across runtimes.
 */
export function rememberDeviceLossAbort(signal: AbortSignal, error: DeviceLostError): void {
  deviceLossAbortErrors.set(signal, error);
}

export function deviceLostErrorFromAbortSignal(signal: AbortSignal): DeviceLostError | undefined {
  return isDeviceLostError(signal.reason)
    ? signal.reason
    : deviceLossAbortErrors.get(signal);
}

export function deviceLossOutcomeFromError(
  error: unknown,
  sessionUuid?: string,
): DeviceLossOutcome | undefined {
  if (!isDeviceLostError(error)) {
    return undefined;
  }
  return {
    code: DEVICE_LOSS_OUTCOME_CODE,
    deviceId: error.deviceId,
    ...(sessionUuid ? { sessionUuid } : {}),
    ...(error.incidentId ? { incidentId: error.incidentId } : {}),
    reason: "confirmed-unavailable",
  };
}

export function enrichDeviceLossOutcome(
  outcome: DeviceLossOutcome,
  incident: EmulatorLossIncident | undefined,
): DeviceLossOutcome {
  if (!incident) {
    return outcome;
  }
  const sessionState = incident.session?.state;
  return {
    ...outcome,
    detectionPath: incident.detectionPath,
    ...(incident.avdName ? { avdName: incident.avdName } : {}),
    ...(incident.replacementDeviceId ? { replacementDeviceId: incident.replacementDeviceId } : {}),
    ...(sessionState ? { sessionState } : {}),
    ...(incident.session
      ? {
          heartbeat: {
            lastHeartbeatMs: incident.session.lastHeartbeatMs,
            hasReceivedHeartbeat: incident.session.hasReceivedHeartbeat,
            timeoutMs: incident.session.heartbeatTimeoutMs,
          },
        }
      : {}),
    recovery: {
      status: incident.recovery.outcome ?? "pending",
      attempts: incident.recovery.attempts.length,
    },
    retry: {
      sameSession: sessionState === "active",
      requiresNewSession: sessionState === "released",
    },
  };
}
