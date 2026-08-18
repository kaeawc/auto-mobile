export const DEVICE_LOSS_OUTCOME_CODE = "device_lost";
const deviceLossAbortErrors = new WeakMap<AbortSignal, DeviceLostError>();

export interface DeviceLossOutcome {
  code: typeof DEVICE_LOSS_OUTCOME_CODE;
  deviceId: string;
  sessionUuid?: string;
  incidentId?: string;
  reason: "confirmed-unavailable";
}

/**
 * A device-loss cancellation is infrastructure failure, not an application or
 * tool failure. Keep the original cancellation reason as the error message so
 * existing logs remain searchable.
 */
export class DeviceLostError extends Error {
  readonly code = DEVICE_LOSS_OUTCOME_CODE;

  constructor(
    readonly deviceId: string,
    reason: string,
    readonly incidentId?: string,
  ) {
    super(reason);
    this.name = "DeviceLostError";
  }
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
