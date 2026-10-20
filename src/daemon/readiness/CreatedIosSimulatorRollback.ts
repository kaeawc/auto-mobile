import { IOSCtrlProxyClient } from "../../features/observe/ios";
import { ActionableError, BootedDevice } from "../../models";
import { type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { isIosSimulatorAlreadyStoppedError } from "../../utils/ios-cmdline-tools/simulatorStateErrors";
import { logger } from "../../utils/logger";
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
    await shutDownCreatedIosSimulator(context, device, cleanupSignal);
    step = "delete";
    await context.simctl()!.deleteSimulator(created.deviceId, { signal: cleanupSignal });
    step = "verify absence of";
    await verifyCreatedIosSimulatorAbsent(context, created.deviceId, cleanupSignal);
  } catch (cleanupError) {
    // The caller's failure is what explains the request; a rollback error never replaces it.
    const state = await readCreatedIosSimulatorState(context, created.deviceId, cleanupSignal);
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
): Promise<void> {
  try {
    await context.simctl()!.killSimulator(device, { signal });
  } catch (error) {
    if (!isIosSimulatorAlreadyStoppedError(error)) {
      throw error;
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
): Promise<void> {
  const deadlineMs = context.runnerReadinessTimer.now() + CREATED_IOS_ABSENCE_TIMEOUT_MS;
  for (;;) {
    const images = await context.simctl()!.listSimulatorImages(undefined, {
      bypassCache: true,
      signal,
    });
    if (!images.some((image) => image.deviceId === udid)) {
      return;
    }
    if (context.runnerReadinessTimer.now() >= deadlineMs) {
      throw new ActionableError(`iOS simulator ${udid} is still listed after delete.`);
    }
    await context.runnerReadinessTimer.sleep(CREATED_IOS_ABSENCE_POLL_MS);
  }
}

export async function readCreatedIosSimulatorState(
  context: Pick<CreatedIosSimulatorRollbackContext, "simctl">,
  udid: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const images = await context.simctl()!.listSimulatorImages(undefined, {
      bypassCache: true,
      signal,
    });
    const image = images.find((candidate) => candidate.deviceId === udid);
    return image ? (image.state ?? "unknown") : "absent";
  } catch (error) {
    logger.debug(`[DeviceReadiness] Could not read state of ${udid}: ${errorMessage(error)}`);
    return "unknown";
  }
}
