export const DEVICE_LOSS_OUTCOME_CODE = "device_lost";

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

const deviceLossAbortErrors = new WeakMap<AbortSignal, DeviceLostError>();

export function isDeviceLostError(error: unknown): error is DeviceLostError {
  return error instanceof DeviceLostError;
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
  return isDeviceLostError(signal.reason) ? signal.reason : deviceLossAbortErrors.get(signal);
}
