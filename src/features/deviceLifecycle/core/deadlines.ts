import { type Timer } from "../../../utils/SystemTimer";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { Platform, BootedDevice, ActionableError } from "../../../models";
import { DeviceShutdownTimeoutError } from "../../../models/DeviceShutdownTimeoutError";
import {
  getVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleOperation,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "../../../devices/virtualDeviceLifecycleCoordinator";
import { runWithAbortSignal, runOutsideRequestContext } from "../../../utils/AbortContext";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { provisionDeviceTimeoutError } from "../provisioning/provisioning";

export const DEVICE_ALREADY_STOPPED_ERROR_CODE = "device_already_stopped";

// A successful platform shutdown command only confirms that the request was
// accepted. Keep the public killDevice result coupled to the observable device
// lifecycle, while bounding the wait so a wedged platform command is actionable.
export const DEVICE_SHUTDOWN_TIMEOUT_MS = 30_000;

export const PROVISION_DEVICE_SETTLEMENT_WAIT_MS = 5_000;

export async function waitForProvisionDeviceSettlement(
  operation: Promise<unknown>,
  timer: Pick<Timer, "setTimeout" | "clearTimeout">,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = new Error("Provision device settlement wait timed out");
  try {
    return await raceWithDeadline(
      // Only settlement matters; the original lifecycle failure is handled by its owner.
      operation.then(
        () => true,
        () => true,
      ),
      {
        timer,
        timeoutMs,
        label: "Provision device settlement",
        timeoutError: () => deadline,
      },
    );
  } catch (error) {
    if (error === deadline) {
      return false;
    }
    throw error;
  }
}

export function createToolErrorResponse(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: false, message, error: { code, message }, ...details }),
      },
    ],
  };
}

export interface StableDeviceTarget {
  platform: Platform;
  stableId: string;
}

export type StableDeviceLifecycleTimeoutFactory = (detail: string) => Error;

/**
 * Shared deadline mapping for every lifecycle reservation, stable or selector:
 * a coordinator rejection at or after the deadline is contention, so it must
 * carry the caller's structured timeout error rather than surfacing as an
 * opaque platform failure. Kept synchronous so callers add no extra await hop.
 */
export function rethrowDeviceLifecycleReservationFailure(
  error: unknown,
  timer: Timer,
  deadlineMs: number,
  timeoutError: StableDeviceLifecycleTimeoutFactory,
  timeoutDetail: string,
): never {
  if (timer.now() >= deadlineMs) {
    throw timeoutError(timeoutDetail);
  }
  throw error;
}

export function shutdownTimeoutError(
  device: BootedDevice,
  detail: string,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
  // Not every deadline-bounded phase is a device disappearing (System UI ANR
  // recovery lists AVD images and issues a kill command under this same
  // deadline), so callers can name their own phase. The "Timed out waiting for"
  // prefix is load-bearing: `isShutdownTimeoutError` classifies on it.
  phase = "to disappear",
): ActionableError {
  return new DeviceShutdownTimeoutError(
    `Timed out waiting for ${device.platform} device '${device.name}' (${device.deviceId}) ` +
      `${phase} after ${timeoutMs}ms: ${detail}. ` +
      "Verify the platform shutdown state and retry.",
  );
}

export async function reserveStableDeviceLifecycle(
  target: StableDeviceTarget,
  deadlineDevice: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  {
    requestAbortSignal,
    timeoutError = (detail) => shutdownTimeoutError(deadlineDevice, detail),
    operation = "start",
    coordinator = getVirtualDeviceLifecycleCoordinator(),
  }: {
    requestAbortSignal: AbortSignal | undefined;
    timeoutError?: StableDeviceLifecycleTimeoutFactory;
    operation?: VirtualDeviceLifecycleOperation;
    coordinator?: VirtualDeviceLifecycleCoordinator;
  },
): Promise<VirtualDeviceLifecycleLease> {
  try {
    return await coordinator.reserve(
      {
        kind: "stable",
        platform: target.platform,
        stableId: target.stableId,
      },
      {
        operation,
        deadlineMs,
        signal: requestAbortSignal,
      },
    );
  } catch (error) {
    rethrowDeviceLifecycleReservationFailure(
      error,
      timer,
      deadlineMs,
      timeoutError,
      "waiting for stable device lifecycle reservation",
    );
  }
}

/**
 * Resolves when `operation` settles or after `boundMs`, whichever comes first.
 * Never rejects: the caller only needs to know the wait is over.
 */
export async function settleWithin(
  operation: Promise<unknown>,
  timer: Timer,
  boundMs: number,
): Promise<void> {
  const deadline = new Error("Settlement wait timed out");
  try {
    await raceWithDeadline(
      operation.then(
        () => undefined,
        () => undefined,
      ),
      { timer, timeoutMs: boundMs, label: "Settlement wait", timeoutError: () => deadline },
    );
  } catch (error) {
    if (error !== deadline) {
      throw error;
    }
  }
}

export async function runWithinShutdownDeadline<T>(
  device: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  detail: string,
  {
    requestAbortSignal,
    operation,
    timeoutMs,
    phase,
    onOrphan,
  }: {
    requestAbortSignal: AbortSignal | undefined;
    operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>;
    timeoutMs?: number;
    phase?: string;
    onOrphan?: (pending: Promise<unknown>) => void;
  },
): Promise<T> {
  const remainingMs = deadlineMs - timer.now();
  // The wait is always `remainingMs`; `timeoutMs` only names the caller's own
  // narrower budget for the message. Without one, quote the budget that
  // actually elapsed rather than the unrelated default shutdown budget.
  const reportedTimeoutMs = timeoutMs ?? Math.max(0, remainingMs);
  if (remainingMs <= 0) {
    throw shutdownTimeoutError(device, detail, reportedTimeoutMs, phase);
  }
  const deadlineController = new AbortController();
  const signal = requestAbortSignal
    ? AbortSignal.any([requestAbortSignal, deadlineController.signal])
    : deadlineController.signal;
  let timedOut = false;
  let operationSettled = false;
  const operationPromise = Promise.resolve()
    .then(() => runWithAbortSignal(signal, () => operation(signal, remainingMs)))
    .then(
      (result) => {
        operationSettled = true;
        return result;
      },
      (error) => {
        operationSettled = true;
        if (timedOut) {
          throw shutdownTimeoutError(device, detail, reportedTimeoutMs, phase);
        }
        throw error;
      },
    );
  // If the deadline wins while a platform command ignores abort, the race is
  // settled but the underlying promise remains observed rather than leaking an
  // unhandled rejection when it eventually completes.
  operationPromise.catch(() => undefined);
  try {
    return await raceWithDeadline(operationPromise, {
      timer,
      timeoutMs: remainingMs,
      signal: requestAbortSignal,
      label: "Device shutdown",
      relabelDefaultAbort: false,
      timeoutError: () => {
        timedOut = true;
        deadlineController.abort();
        return shutdownTimeoutError(device, detail, reportedTimeoutMs, phase);
      },
    });
  } catch (error) {
    if (!operationSettled) {
      onOrphan?.(operationPromise);
    }
    throw error;
  }
}

/**
 * Sleep for `delay` ms, racing against `signal` for prompt cancellation.
 * Mirrors RetryExecutor.sleepUnlessAborted's cleanup pattern so neither the
 * timer handle nor the abort listener remains registered after the race.
 */
export async function sleepUnlessAborted(
  timer: Timer,
  delay: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) {
    await timer.sleep(delay);
    return false;
  }
  if (signal.aborted) {
    return true;
  }
  let onAbort: (() => void) | undefined;
  let handle: NodeJS.Timeout | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      handle = timer.setTimeout(() => resolve(false), delay);
      if (signal.aborted) {
        resolve(true);
        return;
      }
      onAbort = () => resolve(true);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (handle !== undefined) {
      timer.clearTimeout(handle);
    }
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * An operation raced against its request's cancellation and deadline. Losing the race does not
 * stop it, so one that commits something for its caller registers how to take that back with
 * `undoIfUndelivered`: the undo runs with the result when the operation succeeds after the race
 * was already lost, i.e. exactly when the caller got an error instead of that result.
 */
export type DeadlineBoundOperation<T> = (
  signal: AbortSignal,
  undoIfUndelivered: (undo: (result: T) => Promise<void>) => void,
  onDelivered: (commit: () => void) => void,
) => Promise<T>;

/** How a deadline-bound operation fails on its deadline, and who settles it if it is orphaned. */
export interface DeadlineBoundOperationOptions {
  timeoutError: () => Error;
  onOrphan?: (pending: Promise<unknown>) => void;
}

export async function runOperationWithinDeadline<T>(
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  totalDeadlineMs: number,
  requestSignal: AbortSignal | undefined,
  operation: DeadlineBoundOperation<T>,
  { timeoutError, onOrphan }: DeadlineBoundOperationOptions,
): Promise<T> {
  const remainingMs = Math.floor(totalDeadlineMs - timer.now());
  if (remainingMs <= 0) {
    throw timeoutError();
  }

  const controller = new AbortController();
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, controller.signal])
    : controller.signal;
  let operationSettled = false;
  let undo: ((result: T) => Promise<void>) | undefined;
  let delivered: (() => void) | undefined;
  const registerUndo = (registered: (result: T) => Promise<void>): void => {
    undo = registered;
  };
  const takeBackUndelivered = async (
    result: T,
    takeBack: (result: T) => Promise<void>,
  ): Promise<T> => {
    try {
      // The request that started this work is over; its cancellation must not stop the undo.
      await runOutsideRequestContext(() => takeBack(result));
    } catch (error) {
      logger.warn(`Undoing an undelivered operation result failed: ${errorMessage(error)}`, error);
    }
    operationSettled = true;
    return result;
  };
  const operationPromise = runWithAbortSignal(signal, () =>
    operation(signal, registerUndo, (commit) => {
      delivered = commit;
    }),
  ).then(
    (result) => {
      // Returning `result` settles this promise in the same turn, so the race below delivers it
      // unless the request was already cancelled or timed out. Then the race is lost for good,
      // nobody receives `result`, and the operation stays unsettled (an orphan) until it is undone.
      const takeBack = undo;
      if (takeBack && (requestSignal?.aborted || controller.signal.aborted)) {
        return takeBackUndelivered(result, takeBack);
      }
      operationSettled = true;
      return result;
    },
    (error: unknown) => {
      operationSettled = true;
      throw error;
    },
  );
  void operationPromise.catch((error) => {
    // The deadline race owns the failure; this observer also handles late abort rejection.
    logger.debug(`Provision operation rejection observed: ${errorMessage(error)}`);
  });

  try {
    const result = await raceWithDeadline(operationPromise, {
      timer,
      timeoutMs: remainingMs,
      signal: requestSignal,
      label: "Provision operation",
      timeoutError: () => {
        const error = timeoutError();
        controller.abort(error);
        return error;
      },
    });
    delivered?.();
    return result;
  } catch (error) {
    if (!operationSettled) {
      onOrphan?.(operationPromise);
    }
    throw error;
  }
}

export async function runProvisionDeviceWithinDeadline<T>(
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  totalDeadlineMs: number,
  requestSignal: AbortSignal | undefined,
  operation: DeadlineBoundOperation<T>,
  {
    phase,
    onPendingSettlement,
  }: { phase: string; onPendingSettlement?: (settlement: Promise<unknown>) => void },
): Promise<T> {
  return await runOperationWithinDeadline(timer, totalDeadlineMs, requestSignal, operation, {
    timeoutError: () => provisionDeviceTimeoutError(phase),
    onOrphan: onPendingSettlement,
  });
}
