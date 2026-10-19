import { adbFailureOutput } from "./adbFailureOutput";
import { ActionableError } from "../../models/ActionableError";
import { DeviceLostError } from "../../models/DeviceLostError";
import { errorMessage } from "../describeUnknownError";

/** ADB refused the command before dispatch; the session is not confirmed lost. */
export class AdbDeviceTransportUnavailableError extends ActionableError {
  readonly code = "device_transport_unavailable";
  readonly retryable = true;
  readonly dispatched = false;

  constructor(
    readonly deviceId: string,
    cause: unknown,
    readonly retryAfterMs = 1000,
  ) {
    const stderr = adbFailureOutput(cause).stderr.trim().slice(-300);
    const message = errorMessage(cause);
    const diagnostic = stderr && !message.includes(stderr) ? `${message}\n${stderr}` : message;
    super(`ADB transport unavailable for ${deviceId}. Retry the operation: ${diagnostic}`, {
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

/** Preserve this refusal across boundaries that otherwise flatten contextual errors. */
export function rethrowDeviceTransportUnavailable(error: unknown): void {
  const transport = findDeviceTransportUnavailable(error);
  if (transport) {
    throw transport;
  }
}
