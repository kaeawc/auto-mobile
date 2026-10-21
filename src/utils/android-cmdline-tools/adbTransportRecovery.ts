import { isDeviceLossCancellationReason } from "../deviceLossCancellationReason";
import { OPERATION_CANCELLED_MESSAGE } from "../constants";
import { adbFailureOutput } from "./adbFailureOutput";
import { isPreDispatchError } from "./adbCommandRetryPolicy";
import { DeviceLostError } from "../../models/DeviceLostError";
import { deviceLostErrorFromAbortSignal } from "../deviceLossAbortRegistry";
import { sequenceBackoff, type BackoffPolicy } from "../Backoff";
import { type Timer } from "../SystemTimer";
import { DefaultRetryExecutor } from "../retry/RetryExecutor";
import {
  isAdbDeviceOfflineError,
  isAdbMissingDeviceError,
  isAdbPostDispatchTransportError,
} from "./AdbDeviceHealth";
import { AdbDeviceTransportUnavailableError } from "./AdbDeviceTransportUnavailableError";

export const ADB_TRANSPORT_RECOVERY_WINDOW_MS = 3750;
export const ADB_TRANSPORT_RECOVERY_BACKOFF = sequenceBackoff([250, 500, 1000, 2000]);

/** Inspect ADB's stderr, never caller argv or a remote command's stdout. */
function isOwnTransportRefusal(error: unknown, deviceId?: string, transportId?: string): boolean {
  if (
    !deviceId ||
    error instanceof DeviceLostError ||
    error instanceof AdbDeviceTransportUnavailableError
  ) {
    return false;
  }
  const underlying = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if (!(underlying instanceof Error) || underlying instanceof DeviceLostError) {
    return false;
  }
  const stderr = adbFailureOutput(error).stderr.trim();
  const text =
    stderr || (underlying.message.startsWith("Command failed:") ? "" : underlying.message);
  return isAdbMissingDeviceError(text, deviceId, transportId) || isAdbDeviceOfflineError(text);
}

/** A serial-less diagnostic belongs to this client's selected -s transport. */
function isOwnPostDispatchTransportFailure(
  error: unknown,
  deviceId?: string,
  transportId?: string,
): boolean {
  if (!deviceId || (error instanceof Error && isPreDispatchError(error))) {
    return false;
  }
  let current = error;
  let exitCode: number | undefined;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (
      current instanceof DeviceLostError ||
      current instanceof AdbDeviceTransportUnavailableError
    ) {
      return false;
    }
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "number") {
      exitCode ??= code;
    }
    current = current.cause;
  }
  const { stdout, stderr } = adbFailureOutput(error);
  return isAdbPostDispatchTransportError(stderr, exitCode, deviceId, transportId, stdout);
}

interface TransportRecoveryOptions {
  deviceId?: string;
  transportId?: string;
  timer: Timer;
  backoff: BackoffPolicy;
  /** Remaining whole-command budget, including path discovery and prior general retries. */
  remainingMs: () => number | undefined;
  signal?: AbortSignal;
  onExhausted: (error: unknown) => void;
}

function rethrowPostDispatchTransportFailure(
  error: unknown,
  { signal, deviceId, transportId }: TransportRecoveryOptions,
): void {
  if (
    !signal?.aborted &&
    !isOwnTransportRefusal(error, deviceId, transportId) &&
    isOwnPostDispatchTransportFailure(error, deviceId, transportId)
  ) {
    // No replay here. The general retry loop may retry safe reads; even when
    // those exhaust, dispatch of the last attempt remains unknown.
    throw new AdbDeviceTransportUnavailableError(deviceId!, error, 1000, "unknown");
  }
}

/** Only transport refusals are replayed here, including for non-idempotent commands. */
export async function executeWithAdbTransportRecovery<T>(
  operation: (attempt: number) => Promise<T>,
  options: TransportRecoveryOptions,
): Promise<T> {
  const { timer, backoff, signal, deviceId, transportId, remainingMs } = options;
  let recoveryStartedAt: number | undefined;
  let lastRefusal: Error | undefined;
  const remaining = () =>
    Math.max(
      0,
      Math.min(
        remainingMs() ?? Infinity,
        ADB_TRANSPORT_RECOVERY_WINDOW_MS -
          (recoveryStartedAt === undefined ? 0 : timer.now() - recoveryStartedAt),
      ),
    );
  try {
    return await new DefaultRetryExecutor(timer).executeOrThrow(
      async (attempt) => {
        if (
          lastRefusal &&
          ((remainingMs() ?? Infinity) <= 0 ||
            (recoveryStartedAt !== undefined &&
              timer.now() - recoveryStartedAt > ADB_TRANSPORT_RECOVERY_WINDOW_MS))
        ) {
          throw lastRefusal;
        }
        return operation(attempt);
      },
      {
        maxAttempts: 5,
        signal,
        delays: (attempt) => Math.min(backoff.delayForAttempt(attempt), remaining()),
        shouldRetry: (error) => {
          if (signal?.aborted || !isOwnTransportRefusal(error, deviceId, transportId)) {
            return false;
          }
          lastRefusal = error;
          recoveryStartedAt ??= timer.now();
          return remaining() > 0;
        },
        expectedFailure: {
          reason: "Transport refusal is reported by the caller with retry metadata",
        },
      },
    );
  } catch (error) {
    const lost = signal && deviceLostErrorFromAbortSignal(signal);
    if (lost) {
      throw lost;
    }
    rethrowPostDispatchTransportFailure(error, options);
    if (signal?.aborted || !isOwnTransportRefusal(error, deviceId, transportId)) {
      throw error;
    }
    options.onExhausted(error);
    // Notification may synchronously confirm loss and abort the caller.
    const confirmed = signal && deviceLostErrorFromAbortSignal(signal);
    if (confirmed) {
      throw confirmed;
    }
    if (signal?.aborted) {
      signal.throwIfAborted();
    }
    throw new AdbDeviceTransportUnavailableError(deviceId!, error);
  }
}

/** Preserve confirmed loss, including Bun signals whose typed reason is temporarily hidden. */
export function getAdbAbortError(signal?: AbortSignal): Error {
  const lost = signal && deviceLostErrorFromAbortSignal(signal);
  if (lost) {
    return lost;
  }
  const reason = signal?.reason;
  if (reason instanceof Error && isDeviceLossCancellationReason(reason.message)) {
    return reason;
  }
  return new Error(OPERATION_CANCELLED_MESSAGE);
}
