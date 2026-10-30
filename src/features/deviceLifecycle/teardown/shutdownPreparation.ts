import { logger } from "../../../utils/logger";
import { deviceLifecycleServerHost } from "../deviceLifecycleServerHost";
import { getToolSelectionContext } from "../../toolSelection/toolSelectionContext";
import { IOSCtrlProxyManager } from "../../../ctrlProxy/IOSCtrlProxyManager";
import { AndroidCtrlProxyManager } from "../../../ctrlProxy/CtrlProxyManager";
import { unregisterDirectSessionsForStableIdentity } from "../../../utils/directSessionDeviceRegistry";
import { type DevicePool, type PooledDevice } from "../../../daemon/devicePool";
import { BootedDevice, ActionableError, isAndroidOrIosPlatform } from "../../../models";
import { type Timer } from "../../../utils/SystemTimer";
import { createPerformanceTracker } from "../../../utils/PerformanceTracker";
import { type DeviceToolsDependencies } from "../core/dependencies";
import { type TeardownContext, type TeardownResolvedTarget } from "./teardownContracts";
import { runWithinShutdownDeadline } from "../core/deadlines";
import { type TeardownDeviceArgs } from "../core/contracts";

export async function notifyResourcesAfterShutdown(
  dependencies: DeviceToolsDependencies,
): Promise<void> {
  try {
    await dependencies.notifyResourcesChanged();
  } catch (error) {
    // The device is already stopped; resource subscriptions refresh on their next update.
    logger.warn(`[DeviceTools] Failed to notify resource changes after shutdown: ${error}`, error);
  }
}

export async function stopSegmentedVideoRecordingsBeforeDestroy(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<void> {
  await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    "segmented video recording teardown did not complete",
    {
      requestAbortSignal: context.requestAbortSignal,
      operation: async () =>
        await deviceLifecycleServerHost.stopSegmentedVideoRecordingsForDevice(target.device),
      timeoutMs: context.timeoutMs,
    },
  );
}

export function getShutdownInitiatingExecutionId(): string | undefined {
  return getToolSelectionContext()?.execution?.executionId;
}

export async function evictTeardownManagers(
  context: TeardownContext,
  runtimeId?: string,
): Promise<void> {
  const { platform, stableId } = context.args.target;
  if (platform === "ios") {
    if (runtimeId) {
      await IOSCtrlProxyManager.evict(runtimeId, context.dependencies.timer, context.deadlineMs);
    } else {
      await IOSCtrlProxyManager.evict(stableId, context.dependencies.timer, context.deadlineMs);
      await IOSCtrlProxyManager.evictSimulatorByName(
        stableId,
        context.dependencies.timer,
        context.deadlineMs,
      );
    }
  } else {
    AndroidCtrlProxyManager.evict(runtimeId ?? stableId, stableId);
  }
}

export async function finalizeTeardownEviction(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  androidManager: AndroidCtrlProxyManager | undefined,
): Promise<void> {
  unregisterDirectSessionsForStableIdentity(
    target.device.platform,
    target.device.platform === "android"
      ? target.device.name
      : (target.device.deviceId ?? context.args.target.stableId),
  );
  if (androidManager) {
    AndroidCtrlProxyManager.evictInstance(androidManager);
  } else {
    await evictTeardownManagers(context, target.device.deviceId);
  }
}

export function findAbsentTeardownPooledDevices(
  devicePool: Pick<DevicePool, "getAllDevices">,
  target: TeardownDeviceArgs["target"],
): PooledDevice[] {
  return devicePool
    .getAllDevices()
    .filter(
      (device) =>
        device.platform === target.platform &&
        (device.platform === "ios"
          ? device.id === target.stableId
          : (device.avdName ?? device.name) === target.stableId),
    );
}

export const DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES = 2;

export interface ShutdownDeadlineContext {
  device: BootedDevice;
  timer: Timer;
  deadlineMs: number;
  timeoutMs: number;
  requestAbortSignal: AbortSignal | undefined;
  retainReservationUntil?: (operation: Promise<unknown>, releaseAfterFailure?: boolean) => void;
}

export function isShutdownTimeoutError(error: unknown): error is ActionableError {
  return (
    error instanceof ActionableError && String(error.message).startsWith("Timed out waiting for")
  );
}

export function shouldPropagateShutdownPreparationError(
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return isShutdownTimeoutError(error) || requestAbortSignal?.aborted === true;
}

export async function stopVideoRecordingBeforeShutdown(
  recordingId: string,
  context: ShutdownDeadlineContext,
): Promise<void> {
  try {
    await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "video recording teardown did not complete",
      {
        requestAbortSignal: context.requestAbortSignal,
        operation: async () => await deviceLifecycleServerHost.stopVideoRecording(recordingId),
        timeoutMs: context.timeoutMs,
      },
    );
  } catch (error) {
    if (shouldPropagateShutdownPreparationError(error, context.requestAbortSignal)) {
      throw error;
    }
    logger.warn(`[DeviceTools] Failed to stop recording ${recordingId} before shutdown: ${error}`);
  }
}

export async function stopVideoRecordingsBeforeShutdown(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
): Promise<void> {
  perf.startOperation("stopRecordings");
  try {
    await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "segmented video recording teardown did not complete",
      {
        requestAbortSignal: context.requestAbortSignal,
        operation: async () =>
          await deviceLifecycleServerHost.stopSegmentedVideoRecordingsForDevice(context.device),
        timeoutMs: context.timeoutMs,
      },
    );
    const platform = context.device.platform;
    // Video recording does not support watchOS yet, so a watch has no active recordings to stop.
    if (!isAndroidOrIosPlatform(platform)) {
      return;
    }
    const activeRecordings = await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "recording discovery did not complete",
      {
        requestAbortSignal: context.requestAbortSignal,
        operation: async () =>
          await deviceLifecycleServerHost.listActiveVideoRecordings({
            deviceId: context.device.deviceId,
            platform,
          }),
        timeoutMs: context.timeoutMs,
      },
    );
    for (const recording of activeRecordings) {
      await stopVideoRecordingBeforeShutdown(recording.recordingId, context);
    }
  } finally {
    perf.endOperation("stopRecordings");
  }
}

export async function rebuildSameIdReplacement(
  device: BootedDevice,
  expectedPooledDevice: PooledDevice,
  replacement: BootedDevice,
  devicePool: DevicePool,
  stopPerformanceMonitoring: (deviceId: string) => void,
): Promise<void> {
  const rebuilt = await devicePool.replaceDeviceForShutdown(
    expectedPooledDevice,
    replacement,
    () => stopPerformanceMonitoring(device.deviceId),
    { excludeExecutionId: getShutdownInitiatingExecutionId() },
  );
  if (!rebuilt) {
    return;
  }
}
