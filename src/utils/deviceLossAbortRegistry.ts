import { isDeviceLostError, type DeviceLostError } from "../models/DeviceLostError";

// Process-wide registry of the device loss that aborted a signal. It is runtime state, so it
// lives here rather than in src/models, which holds only types and pure functions (#11853).
const deviceLossAbortErrors = new WeakMap<AbortSignal, DeviceLostError>();

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
