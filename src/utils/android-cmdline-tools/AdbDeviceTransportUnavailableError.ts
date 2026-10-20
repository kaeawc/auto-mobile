import { adbFailureOutput } from "./adbFailureOutput";
import { ActionableError } from "../../models/ActionableError";
import { DeviceLostError } from "../../models/DeviceLostError";
import { errorMessage } from "../describeUnknownError";

/** Wire dispatch state; `true` is reserved for a positively confirmed dispatch. */
export type AdbTransportDispatchState = false | "unknown" | true;

/** ADB transport failed; the session is not confirmed lost. */
export class AdbDeviceTransportUnavailableError extends ActionableError {
  readonly code = "device_transport_unavailable";
  readonly retryable = true;

  constructor(
    readonly deviceId: string,
    cause: unknown,
    readonly retryAfterMs = 1000,
    readonly dispatched: AdbTransportDispatchState = false,
  ) {
    const stderr = adbFailureOutput(cause).stderr.trim().slice(-300);
    const message = errorMessage(cause);
    const diagnostic = stderr && !message.includes(stderr) ? `${message}\n${stderr}` : message;
    const action =
      dispatched === false
        ? "Retry the operation"
        : "The command may already have run. Observe before reissuing a non-idempotent command";
    super(`ADB transport unavailable for ${deviceId}. ${action}: ${diagnostic}`, {
      cause,
    });
    this.name = "AdbDeviceTransportUnavailableError";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      dispatched: this.dispatched,
      deviceId: this.deviceId,
    };
  }
}

/** Unwrap contextual errors without downgrading confirmed loss, including cyclic causes. */
export function findDeviceTransportUnavailable(
  error: unknown,
): AdbDeviceTransportUnavailableError | undefined {
  const seen = new Set<Error>();
  let transport: AdbDeviceTransportUnavailableError | undefined;
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof DeviceLostError) {
      return undefined;
    }
    if (error instanceof AdbDeviceTransportUnavailableError) {
      transport ??= error;
    }
    seen.add(error);
    error = error.cause;
  }
  return transport;
}

/** Preserve transport failure and dispatch state across contextual error boundaries. */
export function rethrowDeviceTransportUnavailable(error: unknown): void {
  const transport = findDeviceTransportUnavailable(error);
  if (transport) {
    throw transport;
  }
}
