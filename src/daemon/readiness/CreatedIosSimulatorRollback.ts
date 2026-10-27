import { IOSCtrlProxyClient } from "../../features/observe/ios";
import { ActionableError, BootedDevice } from "../../models";
import { type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { isIosSimulatorAlreadyStoppedError } from "../../utils/ios-cmdline-tools/simulatorStateErrors";
import { logger } from "../../utils/logger";
import { DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import {
  CREATED_IOS_ABSENCE_POLL_MS,
  CREATED_IOS_ABSENCE_TIMEOUT_MS,
  type DeviceClientProvider,
  type DeviceClientSimctl,
} from "./DeviceReadinessContracts";
interface CreatedIosSimulatorRollbackContext {
  simctl: () => DeviceClientSimctl | undefined;
  provider: DeviceClientProvider;
  runnerReadinessTimer: Timer;
}

/** Deletes a simulator this request created and then failed to bind, boot or verify. */
export async function rollBackCreatedIosSimulator(
  context: CreatedIosSimulatorRollbackContext,
  created: { name: string; deviceId?: string },
  failure: unknown,
): Promise<void> {
  const deadlineMs = context.runnerReadinessTimer.now() + DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
  const remainingBudget = (): number => {
    const remainingMs = deadlineMs - context.runnerReadinessTimer.now();
    if (remainingMs <= 0) {
      throw new ActionableError("Created iOS simulator rollback budget exhausted.");
    }
    return remainingMs;
  };
  if (!created.deviceId) {
    logger.warn(
      `[DeviceReadiness] Cannot roll back created iOS simulator '${created.name}': no UDID.`,
    );
    return;
  }
  logger.warn(
    `[DeviceReadiness] Rolling back created iOS simulator '${created.name}' ` +
      `(${created.deviceId}) after failure: ${errorMessage(failure)}`,
  );
  // Cancellation cleanup must not inherit an already-aborted request signal.
  const cleanupSignal = new AbortController().signal;
  const device: BootedDevice = {
    name: created.name,
    platform: "ios",
    deviceId: created.deviceId,
  };
  let step = "retire runner";
  try {
    // Same order as the deleteDevice teardown: runner, shutdown, delete, verify absence.
    await retireCreatedIosRunner(context, device);
    step = "shut down";
    await shutDownCreatedIosSimulator(context, device, cleanupSignal, remainingBudget());
    step = "delete";
    await context.simctl()!.deleteSimulator(created.deviceId, {
      signal: cleanupSignal,
      timeoutMs: remainingBudget(),
    });
    step = "verify absence of";
    remainingBudget();
    await verifyCreatedIosSimulatorAbsent(context, created.deviceId, cleanupSignal, deadlineMs);
  } catch (cleanupError) {
    // The caller's failure is what explains the request; a rollback error never replaces it.
    const remainingMs = deadlineMs - context.runnerReadinessTimer.now();
    const state =
      remainingMs > 0
        ? await readCreatedIosSimulatorState(context, created.deviceId, cleanupSignal, remainingMs)
        : "unknown";
    logger.warn(
      `[DeviceReadiness] Failed to ${step} created iOS simulator ` +
        `'${created.name}' (${created.deviceId}, state: ${state}); it may be left behind: ` +
        errorMessage(cleanupError),
      cleanupError,
    );
  }
}

/** Mirrors the teardown's pre-shutdown runner stop; a failure is logged, not fatal. */
export async function retireCreatedIosRunner(
  context: Pick<CreatedIosSimulatorRollbackContext, "provider">,
  device: BootedDevice,
): Promise<void> {
  try {
    // Fence the observer first so the runner's socket close cannot reconnect and reboot the simulator.
    await IOSCtrlProxyClient.retireInstance(device.deviceId);
    await context.provider.getIOSCtrlProxyManager(device).stop();
  } catch (error) {
    logger.warn(
      `[DeviceReadiness] Failed to stop CtrlProxy iOS for created simulator ` +
        `${device.deviceId} before rollback: ${errorMessage(error)}`,
      error,
    );
  }
}

export async function shutDownCreatedIosSimulator(
  context: Pick<CreatedIosSimulatorRollbackContext, "simctl">,
  device: BootedDevice,
  signal: AbortSignal,
  timeoutMs = DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
): Promise<void> {
  try {
    await context.simctl()!.killSimulator(device, { signal, timeoutMs });
  } catch (error) {
    if (!isIosSimulatorAlreadyStoppedError(error)) {
      // delete also shuts down the device; a failed shutdown must not skip it.
      logger.warn(
        `[DeviceReadiness] Failed to shut down created iOS simulator ${device.deviceId}; attempting delete: ${errorMessage(error)}`,
        error,
      );
      return;
    }
    // simctl reports the simulator is already Shutdown: the state the delete needs.
    logger.debug(
      `[DeviceReadiness] ${device.deviceId} was already shut down: ${errorMessage(error)}`,
    );
  }
}

export async function verifyCreatedIosSimulatorAbsent(
  context: Pick<CreatedIosSimulatorRollbackContext, "runnerReadinessTimer" | "simctl">,
  udid: string,
  signal: AbortSignal,
  sharedDeadlineMs = Number.POSITIVE_INFINITY,
): Promise<void> {
  const deadlineMs = Math.min(
    context.runnerReadinessTimer.now() + CREATED_IOS_ABSENCE_TIMEOUT_MS,
    sharedDeadlineMs,
  );
  for (;;) {
    const remainingMs = deadlineMs - context.runnerReadinessTimer.now();
    if (remainingMs <= 0) {
      throw new ActionableError(`iOS simulator ${udid} is still listed after delete.`);
    }
    const images = await context.simctl()!.listSimulatorImages(remainingMs, {
      bypassCache: true,
      signal,
    });
    if (!images.some((image) => image.deviceId === udid)) {
      return;
    }
    if (context.runnerReadinessTimer.now() >= deadlineMs) {
      throw new ActionableError(`iOS simulator ${udid} is still listed after delete.`);
    }
    await context.runnerReadinessTimer.sleep(
      Math.min(CREATED_IOS_ABSENCE_POLL_MS, deadlineMs - context.runnerReadinessTimer.now()),
    );
  }
}

export async function readCreatedIosSimulatorState(
  context: Pick<CreatedIosSimulatorRollbackContext, "simctl">,
  udid: string,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  try {
    const images = await context.simctl()!.listSimulatorImages(timeoutMs, {
      bypassCache: true,
      signal,
    });
    const image = images.find((candidate) => candidate.deviceId === udid);
    return image ? (image.state ?? "unknown") : "absent";
  } catch (error) {
    logger.warn(`[DeviceReadiness] Could not read state of ${udid}: ${errorMessage(error)}`, error);
    return "unknown";
  }
}
