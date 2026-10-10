import {
  DEVICE_LOSS_REASON_PREFIX,
  isDeviceLossCancellationReason,
} from "../utils/deviceLossCancellationReason";
import { isDeviceLostError, deviceLostErrorFromAbortSignal } from "../models/DeviceLostError";
export {
  isDeviceLostError,
  deviceLostErrorFromAbortSignal,
  rememberDeviceLossAbort,
} from "../models/DeviceLostError";
import {
  DeviceLostError,
  DEVICE_LOSS_OUTCOME_CODE,
  type EmulatorLossIncident,
  type EmulatorLossSessionState,
} from "../daemon/emulatorLossIncident";

export { DeviceLostError, DEVICE_LOSS_OUTCOME_CODE };
export const DEVICE_LOSS_RESPONSE_HEADROOM_MS = 1_000;

export interface DeviceLossOutcome {
  code: typeof DEVICE_LOSS_OUTCOME_CODE;
  deviceId: string;
  sessionUuid?: string;
  incidentId?: string;
  reason: "confirmed-unavailable";
  detectionPath?: EmulatorLossIncident["detectionPath"];
  avdName?: string;
  replacementDeviceId?: string;
  sessionState?: EmulatorLossSessionState;
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

export function deviceLostErrorFromCancellationReason(reason: string): DeviceLostError | undefined {
  if (!isDeviceLossCancellationReason(reason)) {
    return undefined;
  }
  const details = reason.slice(DEVICE_LOSS_REASON_PREFIX.length);
  const incidentDelimiter = ";incident=";
  const incidentIndex = details.indexOf(incidentDelimiter);
  const deviceId = incidentIndex === -1 ? details : details.slice(0, incidentIndex);
  const incidentId =
    incidentIndex === -1
      ? undefined
      : details.slice(incidentIndex + incidentDelimiter.length) || undefined;
  return deviceId ? new DeviceLostError(deviceId, reason, incidentId) : undefined;
}

export function throwDeviceLostFromAbortSignal(signal?: AbortSignal): void {
  if (!signal) {
    return;
  }
  const deviceLoss = deviceLostErrorFromAbortSignal(signal);
  if (deviceLoss) {
    throw deviceLoss;
  }
}

export function remainingDeviceLossIncidentWaitMs(
  requestTimeoutMs: number | undefined,
  elapsedMs: number,
): number | undefined {
  return requestTimeoutMs === undefined
    ? undefined
    : Math.max(0, requestTimeoutMs - Math.max(0, elapsedMs) - DEVICE_LOSS_RESPONSE_HEADROOM_MS);
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
      sameSession: sessionState === "active" || sessionState === "awaiting-device",
      requiresNewSession: sessionState === "released",
    },
  };
}
