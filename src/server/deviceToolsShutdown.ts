import { deviceLossCancellationReason } from "../daemon/emulatorLossIncident";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { ActionableError, type BootedDevice, type SomePlatform } from "../models";
import type { BootedDeviceDiscovery, PlatformDeviceManager } from "../devices/deviceUtils";
import type { Timer } from "../utils/SystemTimer";
import { fixedBackoff } from "../utils/Backoff";
import { getAbortSignal } from "../utils/AbortContext";
import { DaemonState } from "../daemon/daemonState";
import type { DevicePool, PooledDevice } from "../daemon/devicePool";
import type { Session, SessionManager } from "../daemon/sessionManager";
import { reconcileDiscoveryObservation } from "../daemon/discoveryReconcile";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../features/observe/ios/IOSCtrlProxyClient";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { ambientPerfFor, runWithPerfTracker } from "../utils/PerfContext";
import { listActiveVideoRecordings, stopVideoRecording } from "./videoRecordingManager";
import { stopSegmentedVideoRecordingsForDevice } from "./videoRecordingTools";
import { executionTracker } from "./executionTracker";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import {
  resolveDirectSessionDevice,
  unregisterDirectSessionsForDevice,
} from "./directSessionDeviceRegistry";
import { getInstalledAppsCacheWriteCoordinator } from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";
import { DeviceShutdownService } from "../devices/deviceShutdownService";
import { isAdbMissingDeviceError } from "../utils/android-cmdline-tools/AdbDeviceHealth";
import {
  DEVICE_ALREADY_STOPPED_ERROR_CODE,
  DEVICE_SHUTDOWN_TIMEOUT_MS,
  createToolErrorResponse,
  notifyResourcesAfterShutdown,
  runWithinShutdownDeadline,
  settleWithin,
  confirmPooledAvdIdentity,
  isUnknownAndroidRuntimeName,
  pooledAvdNameRefusalMessage,
  PooledAvdIdentityError,
} from "./deviceTools";
import type { DeviceToolsDependencies, KillDeviceArgs, PooledAvdKillIdentity } from "./deviceTools";

export const DEVICE_SHUTDOWN_POLL_INTERVAL_MS = 1_000;
const DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS = 1_000;
const IOS_SHUTDOWN_CONFIRMATION_MIN_MS = 2_000;
const DEVICE_SHUTDOWN_DISCOVERY_RECHECK_BACKOFF = fixedBackoff(1_000);
export const DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES = 2;

export function getShutdownInitiatingExecutionId(): string | undefined {
  return getToolSelectionContext()?.execution?.executionId;
}

function isAlreadyStoppedDeviceError(
  platform: SomePlatform,
  deviceId: string,
  error: unknown,
): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (platform === "android") {
    return (
      (message.includes("not running") && message.includes("emulator")) ||
      isAdbMissingDeviceError(error, deviceId)
    );
  }
  if (platform === "ios") {
    return (
      message.includes("already shut down") ||
      message.includes("already shutdown") ||
      message.includes("not booted") ||
      message.includes("invalid device state") ||
      message.includes("current state: shutdown")
    );
  }
  return false;
}

export function createKillDeviceResponse(
  args: KillDeviceArgs,
  timing: unknown,
  alreadyStoppedMessage?: string,
) {
  if (alreadyStoppedMessage !== undefined) {
    if (args.device.platform === "ios") {
      return createStructuredToolResponse({
        message: `ios '${args.device.name}' already shut down`,
        udid: args.device.deviceId,
        name: args.device.name,
        timing,
        platform: args.device.platform,
      });
    }
    return createToolErrorResponse(DEVICE_ALREADY_STOPPED_ERROR_CODE, alreadyStoppedMessage);
  }

  return createStructuredToolResponse({
    message: `${args.device.platform} '${args.device.name}' shutdown successfully`,
    udid: args.device.deviceId,
    name: args.device.name,
    timing,
    platform: args.device.platform,
  });
}

async function clearInstalledAppsAfterShutdown(
  dependencies: DeviceToolsDependencies,
  deviceId: string,
): Promise<boolean> {
  try {
    await dependencies.clearInstalledAppsForDevice(deviceId);
    return true;
  } catch (error) {
    // The device is already stopped; the next app verification refreshes stale cache rows.
    logger.warn(
      `[DeviceTools] Failed to clear installed apps for ${deviceId} after shutdown: ${error}`,
      error,
    );
    return false;
  }
}

export interface ShutdownDeadlineContext {
  device: BootedDevice;
  timer: Timer;
  deadlineMs: number;
  timeoutMs: number;
  requestAbortSignal: AbortSignal | undefined;
  retainReservationUntil?: (operation: Promise<unknown>, releaseAfterFailure?: boolean) => void;
}

interface AndroidObserverShutdownState {
  hadActiveObserver: boolean;
  boundSessionId: string | null;
  deviceIdentity: BootedDevice | null;
}

function shouldPropagateShutdownPreparationError(
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return isShutdownTimeoutError(error) || requestAbortSignal?.aborted === true;
}

async function stopVideoRecordingBeforeShutdown(
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
        operation: async () => await stopVideoRecording(recordingId),
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
        operation: async () => await stopSegmentedVideoRecordingsForDevice(context.device),
        timeoutMs: context.timeoutMs,
      },
    );
    const activeRecordings = await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "recording discovery did not complete",
      {
        requestAbortSignal: context.requestAbortSignal,
        operation: async () =>
          await listActiveVideoRecordings({
            deviceId: context.device.deviceId,
            platform: context.device.platform,
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

async function stopIosCtrlProxyBeforeShutdown(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
): Promise<void> {
  if (context.device.platform !== "ios") {
    return;
  }
  let stop: Promise<void> | undefined;
  perf.startOperation("stopCtrlProxy");
  try {
    const xcTestManager = IOSCtrlProxyManager.getInstance({
      name: context.device.name,
      platform: "ios",
      deviceId: context.device.deviceId,
      source: "local",
    });
    stop = (async () => {
      // Fence the observer before stopping its runner. Otherwise the runner's
      // intentional socket close can schedule auto-reconnect and restart the
      // simulator after killDevice has confirmed shutdown.
      await IOSCtrlProxyClient.retireInstance(context.device.deviceId);
      await xcTestManager.stop();
    })();
    await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "iOS CtrlProxy shutdown did not complete",
      {
        requestAbortSignal: context.requestAbortSignal,
        operation: async () => await stop,
        timeoutMs: context.timeoutMs,
      },
    );
  } catch (error) {
    if (shouldPropagateShutdownPreparationError(error, context.requestAbortSignal)) {
      resumeCtrlProxyWhenPreparationSettles(stop, context.device);
      if (stop) {
        // CtrlProxy shutdown mutates process state after its caller stops waiting.
        // Keep this device unavailable until it settles, but release it after a
        // failed pre-kill teardown because the platform was never shut down.
        context.retainReservationUntil?.(stop, true);
      }
      throw error;
    }
    logger.warn(`[DeviceTools] Failed to stop CtrlProxy iOS before kill: ${error}`);
  } finally {
    perf.endOperation("stopCtrlProxy");
  }
}

async function stopAndroidCtrlProxyBeforeShutdown(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
  stopAndroidObservers: (device: BootedDevice) => Promise<void>,
): Promise<AndroidObserverShutdownState> {
  if (context.device.platform !== "android") {
    return { hadActiveObserver: false, boundSessionId: null, deviceIdentity: null };
  }
  const activeObserver = AndroidCtrlProxyClient.getExistingInstance(context.device.deviceId);
  const activeDeviceIdentity = activeObserver?.getBootedDeviceIdentity();
  const observerState: AndroidObserverShutdownState = {
    hadActiveObserver: activeObserver !== null,
    boundSessionId: activeObserver?.getBoundSessionId() ?? null,
    deviceIdentity: activeDeviceIdentity ?? null,
  };
  AndroidCtrlProxyClient.retireForShutdown(context.device.deviceId);
  let stop: Promise<void> | undefined;
  perf.startOperation("stopAndroidCtrlProxy");
  try {
    stop = stopAndroidObservers(context.device);
    await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "Android observer detach did not complete",
      { requestAbortSignal: context.requestAbortSignal, operation: async () => await stop },
    );
  } catch (error) {
    if (shouldPropagateShutdownPreparationError(error, context.requestAbortSignal)) {
      resumeCtrlProxyWhenPreparationSettles(stop, context.device);
      if (stop) {
        // Observer detach can keep mutating adb/port state after its caller stops
        // waiting. Hold the device unavailable until it settles, releasing after a
        // failed pre-kill teardown because the platform was never shut down.
        context.retainReservationUntil?.(stop, true);
      }
      throw error;
    }
    logger.warn(`[DeviceTools] Failed to stop Android observers before kill: ${error}`);
  } finally {
    perf.endOperation("stopAndroidCtrlProxy");
  }
  return observerState;
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
  return new ActionableError(
    `Timed out waiting for ${device.platform} device '${device.name}' (${device.deviceId}) ` +
      `${phase} after ${timeoutMs}ms: ${detail}. ` +
      "Verify the platform shutdown state and retry.",
  );
}

export function isShutdownTimeoutError(error: unknown): error is ActionableError {
  return (
    error instanceof ActionableError && String(error.message).startsWith("Timed out waiting for")
  );
}

export function shouldClearIntentionalShutdownAfterFailure(
  platform: SomePlatform,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return platform === "android" && !requestAbortSignal?.aborted;
}

async function resumeCtrlProxyAfterFailedKill(device: BootedDevice): Promise<void> {
  const daemonState = DaemonState.getInstance();
  if (
    daemonState.isInitialized() &&
    (await daemonState.getDevicePool().isShutdownReserved(device.deviceId))
  ) {
    return;
  }
  if (device.platform === "ios") {
    IOSCtrlProxyClient.resumeAfterDeviceStart(device.deviceId);
  } else if (device.platform === "android") {
    AndroidCtrlProxyClient.resumeAfterDeviceStart(device.deviceId);
  }
}

async function resumeCtrlProxyAfterUnconfirmedFailure(
  device: BootedDevice,
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
  shutdownWasConfirmed = false,
): Promise<void> {
  if (
    !shutdownWasConfirmed &&
    !isAlreadyStoppedDeviceError(device.platform, device.deviceId, error) &&
    !shouldKeepIntentionalShutdownAfterCommandError(error, requestAbortSignal)
  ) {
    await resumeCtrlProxyAfterFailedKill(device);
  }
}

function resumeCtrlProxyWhenPreparationSettles(
  stop: Promise<void> | undefined,
  device: BootedDevice,
): void {
  // The same in-flight teardown retains the pool reservation on timeout/abort.
  // A new shutdown or an unresolved shutdown marker keeps the client retired.
  void stop?.then(
    () => resumeCtrlProxyAfterFailedKill(device),
    () => resumeCtrlProxyAfterFailedKill(device),
  );
}

function shouldKeepIntentionalShutdownAfterCommandError(
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return requestAbortSignal?.aborted === true || isShutdownTimeoutError(error);
}

function shouldRestoreAndroidObserverAfterCommandFailure(
  device: BootedDevice,
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return (
    device.platform === "android" &&
    !isAlreadyStoppedDeviceError(device.platform, device.deviceId, error) &&
    !shouldKeepIntentionalShutdownAfterCommandError(error, requestAbortSignal)
  );
}

function hasLiveAndroidObserverSessionBinding(
  device: BootedDevice,
  boundSessionId: string | null,
  deviceIdentity: BootedDevice | null,
): boundSessionId is string {
  if (boundSessionId === null) {
    return false;
  }
  const daemonState = DaemonState.getInstance();
  if (daemonState.isInitialized()) {
    return daemonState.getSessionManager().getSessionForDevice(device.deviceId) === boundSessionId;
  }
  const directSession = resolveDirectSessionDevice(boundSessionId);
  return (
    directSession !== undefined &&
    deviceIdentity !== null &&
    isSameBootedDeviceIdentity(deviceIdentity, directSession.device)
  );
}

function bindLiveAndroidObserverSession(
  observer: AndroidCtrlProxyClient,
  device: BootedDevice,
  observerState: AndroidObserverShutdownState,
): void {
  if (
    hasLiveAndroidObserverSessionBinding(
      device,
      observerState.boundSessionId,
      observerState.deviceIdentity,
    )
  ) {
    observer.bindSession(observerState.boundSessionId);
  }
}

function invalidateAndroidObserver(observer: AndroidCtrlProxyClient, deviceId: string): void {
  // Removal is deliberately synchronous and precedes cleanup. `close()` can
  // wait on an ADB forward removal that does not honour the shutdown deadline;
  // retaining the singleton until that completes would keep an obsolete client
  // (and the failed-shutdown reservation) alive indefinitely.
  observer.invalidateForShutdownRecovery();
  void observer.close().catch((error) => {
    logger.warn(
      `[DeviceTools] Failed to clean up invalidated Android observer for ${deviceId}: ${error}`,
    );
  });
}

export interface ShutdownDiscoveryContext {
  deviceManager: PlatformDeviceManager;
  device: BootedDevice;
  timer: Timer;
  deadlineMs: number;
  requestAbortSignal: AbortSignal | undefined;
  timeoutMs: number;
}

interface ShutdownObserverRecoveryContext {
  deviceManager: PlatformDeviceManager;
  device: BootedDevice;
  timer: Timer;
  shutdownDeadlineMs: number;
  requestAbortSignal: AbortSignal | undefined;
  timeoutMs: number;
}

async function reconnectAndroidObserverWithinShutdownDeadline(
  context: Pick<
    ShutdownObserverRecoveryContext,
    "device" | "timer" | "shutdownDeadlineMs" | "requestAbortSignal" | "timeoutMs"
  >,
  observer: AndroidCtrlProxyClient,
): Promise<boolean> {
  const { device, timer, shutdownDeadlineMs, requestAbortSignal, timeoutMs } = context;
  const reconnect = async (): Promise<boolean> => {
    try {
      return await runWithinShutdownDeadline(
        device,
        timer,
        shutdownDeadlineMs,
        "Android observer reconnect did not complete",
        {
          requestAbortSignal: requestAbortSignal,
          operation: async () => await observer.ensureConnected(),
          timeoutMs: timeoutMs,
        },
      );
    } catch (error) {
      if (isShutdownTimeoutError(error) || requestAbortSignal?.aborted) {
        // Platform setup does not accept an AbortSignal. Invalidate the
        // in-flight client so a late port-forward cannot register a stale
        // observer or leave future callers waiting on its connection.
        invalidateAndroidObserver(observer, device.deviceId);
      }
      throw error;
    }
  };
  const connected = await reconnect();
  // A failed port-forward setup has no WebSocket close event to trigger the
  // normal automatic reconnect. Retry once while the shutdown budget is still
  // live so existing passive subscribers regain their cadence.
  return connected || (await reconnect());
}

async function revalidateReconnectedAndroidObserver(
  context: ShutdownObserverRecoveryContext,
  observer: AndroidCtrlProxyClient,
  observerState: AndroidObserverShutdownState,
): Promise<boolean> {
  const { device } = context;
  try {
    // Recheck after the awaited reconnect: ADB addresses a reusable serial,
    // so the original pre-connect check is no longer sufficient if an emulator
    // rebooted while its port-forward or WebSocket was starting.
    const discovery = await getCompleteShutdownDiscovery(context);
    const reconnectedDevice = findDiscoveredDevice(discovery, device);
    return (
      reconnectedDevice !== undefined &&
      observerState.deviceIdentity !== null &&
      isSameBootedDeviceIdentity(observerState.deviceIdentity, reconnectedDevice)
    );
  } catch (error) {
    // A connected observer cannot be safely retained when its incarnation
    // could not be reconfirmed within the same failed-shutdown budget.
    invalidateAndroidObserver(observer, device.deviceId);
    throw error;
  }
}

async function restoreAndroidObserverAfterCommandFailure(
  context: ShutdownObserverRecoveryContext,
  observerState: AndroidObserverShutdownState,
  error: unknown,
): Promise<void> {
  const { device, requestAbortSignal } = context;
  if (
    !observerState.hadActiveObserver ||
    !shouldRestoreAndroidObserverAfterCommandFailure(device, error, requestAbortSignal)
  ) {
    return;
  }
  try {
    // The pre-kill teardown evicts the observer to release its transport hold.
    // Recreate it only after a fresh, uncached discovery proves this exact
    // incarnation survived the failed command; a disappeared device or a
    // same-ID reboot must stay detached.
    const discovery = await getCompleteShutdownDiscovery(context);
    const survivingDevice = findDiscoveredDevice(discovery, device);
    if (
      survivingDevice &&
      observerState.deviceIdentity !== null &&
      isSameBootedDeviceIdentity(observerState.deviceIdentity, survivingDevice)
    ) {
      const daemonState = DaemonState.getInstance();
      if (
        daemonState.isInitialized() &&
        (await daemonState.getDevicePool().isShutdownReserved(device.deviceId))
      ) {
        return;
      }
      AndroidCtrlProxyClient.resumeAfterDeviceStart(device.deviceId);
      const observer = AndroidCtrlProxyClient.getInstance(survivingDevice);
      // Bind before connecting so a frame arriving immediately after the socket
      // opens is attributed to the surviving session. A post-connect identity
      // mismatch still invalidates this client before it is retained.
      bindLiveAndroidObserverSession(observer, device, observerState);
      const connected = await reconnectAndroidObserverWithinShutdownDeadline(context, observer);
      if (!connected) {
        logger.warn(
          `[DeviceTools] Failed to reconnect Android observer after kill failure for ${device.deviceId}`,
        );
        return;
      }
      const sameIncarnation = await revalidateReconnectedAndroidObserver(
        context,
        observer,
        observerState,
      );
      if (!sameIncarnation) {
        invalidateAndroidObserver(observer, device.deviceId);
        return;
      }
    }
  } catch (restoreError) {
    // Preserve the original shutdown command failure. A later explicit tool
    // call can still recreate the observer if this confirmation was unavailable.
    logger.warn(
      `[DeviceTools] Failed to restore Android observer after kill failure for ${device.deviceId}: ${restoreError}`,
      restoreError,
    );
  }
}

function handleShutdownCommandError(
  device: BootedDevice,
  error: unknown,
  devicePool: DevicePool | undefined,
  keepIntentionalShutdown: boolean,
): string | undefined {
  if (isAlreadyStoppedDeviceError(device.platform, device.deviceId, error)) {
    return `Failed to kill ${device.platform} device: ${error}`;
  }
  if (!keepIntentionalShutdown) {
    devicePool?.clearIntentionalShutdown(device.deviceId);
  }
  throw error;
}

async function recoverAfterShutdownFailure(
  device: BootedDevice,
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
  devicePool: DevicePool | undefined,
  releaseShutdownReservation: () => Promise<void>,
  shutdownWasConfirmed: boolean,
): Promise<void> {
  // Only a definitive failure may reopen CtrlProxy after our fence clears;
  // the shared shutdown accessor still blocks a concurrent kill. Timeout or
  // cancellation keeps the marker and the client retired for late shutdown.
  if (
    !shutdownWasConfirmed &&
    shouldClearIntentionalShutdownAfterFailure(device.platform, requestAbortSignal) &&
    !shouldKeepIntentionalShutdownAfterCommandError(error, requestAbortSignal)
  ) {
    devicePool?.clearIntentionalShutdown(device.deviceId);
  }
  if (
    !shutdownWasConfirmed &&
    !isAlreadyStoppedDeviceError(device.platform, device.deviceId, error) &&
    !shouldKeepIntentionalShutdownAfterCommandError(error, requestAbortSignal)
  ) {
    await releaseShutdownReservation();
  }
  await resumeCtrlProxyAfterUnconfirmedFailure(
    device,
    error,
    requestAbortSignal,
    shutdownWasConfirmed,
  );
}

function rethrowShutdownFailure(
  device: BootedDevice,
  requestAbortSignal: AbortSignal | undefined,
  error: unknown,
): never {
  if (error instanceof ActionableError || requestAbortSignal?.aborted) {
    throw error;
  }
  throw new ActionableError(`Failed to kill ${device.platform} device: ${error}`);
}

async function runPostShutdownStep(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
  operationName: "cleanup" | "notifyResources",
  detail: string,
  strictDeadline: boolean,
  operation: () => Promise<void>,
): Promise<void> {
  perf.startOperation(operationName);
  try {
    if (strictDeadline) {
      await runWithinShutdownDeadline(context.device, context.timer, context.deadlineMs, detail, {
        requestAbortSignal: context.requestAbortSignal,
        operation: async () => await operation(),
        timeoutMs: context.timeoutMs,
      });
      return;
    }
    await operation();
  } finally {
    perf.endOperation(operationName);
  }
}

/**
 * `skipAndroidNameEnrichment` is the shutdown-confirmation half of the same
 * `force` fast path `readTeardownTargetDiscovery` already gives target
 * RESOLUTION (#6864): a forced kill still confirms its target's disappearance
 * by discovery, and unforced discovery enriches every attached emulator with
 * `emu avd name`, sequentially, budgeting 2s each. Wedged peer consoles can
 * burn a whole forced teardown deadline confirming a kill that itself
 * completed instantly, reporting a shutdown timeout even though the platform
 * kill succeeded
 * ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review). A
 * serial-only scan is enough here: `findDiscoveredDevice` matches by
 * `deviceId`, so the target's disappearance is confirmed without a name, and
 * an unresolved `Unknown (<serial>)` name on a still-present serial already
 * reads as "not yet a confirmed replacement" via
 * {@link isConfirmedDeviceReplacement}'s unresolved-name guard, the same
 * conservative "keep waiting" outcome an unforced caller gets from a
 * momentarily wedged console.
 */
async function getShutdownDiscovery(
  context: ShutdownDiscoveryContext,
  skipAndroidNameEnrichment = false,
) {
  const { deviceManager, device, timer, deadlineMs, requestAbortSignal, timeoutMs } = context;
  return await runWithinShutdownDeadline(
    device,
    timer,
    deadlineMs,
    "platform discovery did not complete",
    {
      requestAbortSignal: requestAbortSignal ?? getAbortSignal(),
      operation: async () => {
        const discovery = await deviceManager.getBootedDevicesDetailed(device.platform, {
          bypassAndroidDeviceListCache: true,
          ...(device.platform === "ios" ? { bypassIosDeviceListCache: true } : {}),
          ...(skipAndroidNameEnrichment ? { skipAndroidNameEnrichment: true } : {}),
        });
        // FUNNEL 1: the kill/teardown preflight decides whether the pooled AVD
        // label may be acted on destructively, so the pool must see this
        // observation before that decision (#6863 review).
        await reconcileDiscoveryObservation(discovery.devices, "shutdown-preflight", {
          // This kill IS the discovering execution. Entering the quarantine
          // cancels the pooled session's in-flight work, and without this
          // exemption that includes the kill awaiting this very observation: it
          // would lose the `runWithinShutdownDeadline` signal race and report a
          // device-loss failure instead of reaching confirm-or-refuse
          // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
          excludeExecutionId: getShutdownInitiatingExecutionId(),
          signal: getAbortSignal(),
          namesResolved: !skipAndroidNameEnrichment,
        });
        return discovery;
      },
      timeoutMs: timeoutMs,
    },
  );
}

async function getCompleteShutdownDiscovery(context: ShutdownObserverRecoveryContext) {
  const { device, timer, shutdownDeadlineMs, timeoutMs } = context;
  for (;;) {
    const discovery = await getShutdownDiscovery({ ...context, deadlineMs: shutdownDeadlineMs });
    if (discovery.succeededPlatforms.has(device.platform)) {
      return discovery;
    }
    const remainingMs = shutdownDeadlineMs - timer.now();
    if (remainingMs <= 0) {
      throw shutdownTimeoutError(device, "platform discovery did not complete", timeoutMs);
    }
    await timer.sleep(Math.min(DEVICE_SHUTDOWN_POLL_INTERVAL_MS, remainingMs));
  }
}

/**
 * The online-only discovery cannot see an emulator whose adb transport is
 * `offline`: the serial vanishes from it while the process keeps running
 * (#10074). Before an Android serial's absence counts as disappearance, ask adb
 * whether the serial is still attached in that state. Returns why disappearance
 * is NOT yet confirmed, or undefined when the serial is gone from `adb devices`.
 * A manager without the probe keeps the previous online-only behaviour.
 */
async function androidOfflineHoldDetail(
  context: ShutdownDiscoveryContext,
): Promise<string | undefined> {
  const { deviceManager, device, timer, deadlineMs, requestAbortSignal, timeoutMs } = context;
  const probe = deviceManager.getAndroidOfflineDeviceIds?.bind(deviceManager);
  if (device.platform !== "android" || !probe) {
    return undefined;
  }
  try {
    const offline = await runWithinShutdownDeadline(
      device,
      timer,
      deadlineMs,
      "adb device-state read did not complete",
      {
        requestAbortSignal: requestAbortSignal ?? getAbortSignal(),
        operation: async (signal, remainingMs) =>
          await probe([device.deviceId], { signal, timeoutMs: remainingMs }),
        timeoutMs,
      },
    );
    return offline.has(device.deviceId) ? "adb still lists the device as offline" : undefined;
  } catch (error) {
    if (isShutdownTimeoutError(error) || requestAbortSignal?.aborted) {
      throw error;
    }
    // An unreadable state list cannot prove the serial left `adb devices`; keep
    // polling until the deadline rather than retire ownership of a live emulator.
    logger.warn(
      `[DeviceTools] adb device-state probe failed while confirming ${device.deviceId} stopped: ${errorMessage(error)}`,
      error,
    );
    return "adb device states could not be read to confirm the serial is gone";
  }
}

type ShutdownDiscoveryJudgement =
  | { settled: true; replacement: BootedDevice | undefined }
  | { settled: false; detail: string };

async function judgeShutdownDiscovery(
  context: ShutdownDiscoveryContext,
  discovery: BootedDeviceDiscovery,
): Promise<ShutdownDiscoveryJudgement> {
  const { device } = context;
  const platformWasDiscovered = discovery.succeededPlatforms.has(device.platform);
  const matchingDevice = findDiscoveredDevice(discovery, device);
  if (platformWasDiscovered && !matchingDevice) {
    const offlineHoldDetail = await androidOfflineHoldDetail(context);
    return offlineHoldDetail === undefined
      ? { settled: true, replacement: undefined }
      : { settled: false, detail: offlineHoldDetail };
  }
  if (matchingDevice && isConfirmedDeviceReplacement(device, matchingDevice)) {
    return { settled: true, replacement: matchingDevice };
  }
  return {
    settled: false,
    detail: platformWasDiscovered
      ? "the device is still reported as booted"
      : "platform discovery did not succeed",
  };
}

export async function waitForDeviceShutdown(
  context: ShutdownDiscoveryContext,
  skipAndroidNameEnrichment = false,
): Promise<BootedDevice | undefined> {
  const { device, timer, deadlineMs, timeoutMs } = context;
  let lastDiscoveryDetail = "platform discovery did not complete";
  for (;;) {
    if (timer.now() >= deadlineMs) {
      throw shutdownTimeoutError(device, lastDiscoveryDetail, timeoutMs);
    }
    const discovery = await getShutdownDiscovery(context, skipAndroidNameEnrichment);
    const judgement = await judgeShutdownDiscovery(context, discovery);
    if (judgement.settled) {
      return judgement.replacement;
    }
    lastDiscoveryDetail = judgement.detail;
    const remainingMs = deadlineMs - timer.now();
    if (remainingMs <= 0) {
      throw shutdownTimeoutError(device, lastDiscoveryDetail, timeoutMs);
    }
    await timer.sleep(Math.min(DEVICE_SHUTDOWN_POLL_INTERVAL_MS, remainingMs));
  }
}

/**
 * Whether two discovery observations are positive evidence of the same booted
 * runtime -- the CONTINUITY question, asked by callers deciding whether to
 * retain live state (an attached observer, a bound session).
 *
 * A discovery listing carries no connection-epoch token, so this is platform +
 * serial + name and nothing more. An Android emulator serial is reused across
 * boots, and its AVD name is what distinguishes one occupant of that serial
 * from the next; a handset serial is globally unique, so its (non-unique)
 * `ro.product.model` name can never conflate two handsets. The blind spot this
 * leaves is deliberate: a same-serial restart of the SAME AVD between two
 * observations reads as continuity, so callers relying on this must self-heal
 * on failure rather than trust it as proof of an unbroken connection.
 *
 * An `Unknown (<serial>)` name is not an answer to this question. It means the
 * emulator console did not report a name, so it is never evidence of continuity
 * -- and, symmetrically, never evidence of a replacement (see
 * {@link isConfirmedDeviceReplacement}). This is the uniform rule for the
 * placeholder, and the destructive tools' `force` escape hatch (#6864) does not
 * soften it: `force` skips the kill-time console probe, it never makes the
 * placeholder read as an identity here.
 */
function isSameBootedDeviceIdentity(device: BootedDevice, candidate: BootedDevice): boolean {
  return (
    device.platform === candidate.platform &&
    device.deviceId === candidate.deviceId &&
    device.name === candidate.name &&
    !hasUnresolvedEmulatorRuntimeName(device) &&
    !hasUnresolvedEmulatorRuntimeName(candidate)
  );
}

/**
 * Whether a device rediscovered on a serial is positive evidence that a
 * DIFFERENT runtime now holds it -- the REPLACEMENT question, asked by the
 * shutdown wait before it stops waiting and rebuilds the pool around the
 * newcomer.
 *
 * Only a RESOLVED, different name declares a replacement. While an emulator
 * shuts down, `adb devices` can keep listing its serial after the console has
 * stopped answering `avd name`, so the device that is still present gets
 * labelled `Unknown (<serial>)`; classifying that as a replacement would end the
 * shutdown wait before disappearance and retirement, releasing the session and
 * rebuilding the pool around a device that is still going away (#6863 review).
 *
 * This is NOT the negation of {@link isSameBootedDeviceIdentity}: an unresolved
 * name answers neither question, so both predicates return false for it.
 */
function isConfirmedDeviceReplacement(device: BootedDevice, candidate: BootedDevice): boolean {
  if (device.platform !== candidate.platform || device.deviceId !== candidate.deviceId) {
    return false;
  }
  if (hasUnresolvedEmulatorRuntimeName(device) || hasUnresolvedEmulatorRuntimeName(candidate)) {
    return false;
  }
  return device.name !== candidate.name;
}

/**
 * Whether this observation's name is the `Unknown (<serial>)` placeholder rather
 * than a name read from the runtime. Guarded by {@link isAndroidEmulatorSerial}:
 * a handset's name is `ro.product.model`, which is not unique and carries no
 * identity anyway, so handsets keep serial-only identity.
 */
function hasUnresolvedEmulatorRuntimeName(device: BootedDevice): boolean {
  return (
    device.platform === "android" &&
    isAndroidEmulatorSerial(device.deviceId) &&
    isUnknownAndroidRuntimeName(device)
  );
}

function findDiscoveredDevice(
  discovery: BootedDeviceDiscovery,
  device: BootedDevice,
): BootedDevice | undefined {
  if (!discovery.succeededPlatforms.has(device.platform)) {
    return undefined;
  }
  return discovery.devices.find(
    (candidate) => candidate.platform === device.platform && candidate.deviceId === device.deviceId,
  );
}

async function rebuildSameIdReplacement(
  device: BootedDevice,
  expectedPooledDevice: PooledDevice,
  replacement: BootedDevice,
  daemonState: DaemonState,
  stopPerformanceMonitoring: (deviceId: string) => void,
): Promise<void> {
  const devicePool = daemonState.getDevicePool();
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

function shutdownRecheckDeadlineMs(
  timer: Timer,
  deadlineMs: number,
  strictDeadline: boolean,
): number {
  if (strictDeadline) {
    return deadlineMs;
  }
  return Math.max(deadlineMs, timer.now() + DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS);
}

async function findReplacementAfterSessionRelease(
  context: ShutdownOwnershipContext,
  strictDeadline = false,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
  skipAndroidNameEnrichment = false,
): Promise<BootedDevice | undefined> {
  const { deviceManager, device, timer, deadlineMs, requestAbortSignal } = context;
  // The absence observation only proves the old incarnation was gone before
  // session release. A same-ID replacement can appear while that release
  // awaits persistence, so ordinary shutdown keeps a short, bounded recheck
  // even after the disappearance deadline was consumed.
  // Under force, a replacement can only be confirmed by a DIFFERING resolved
  // name (see `isConfirmedDeviceReplacement`), so this serial-only recheck
  // reports no confirmed replacement quickly instead of probing every peer's
  // console -- the same conservative trade-off as the pre-release scan (#6864).
  const recheckDeadlineMs = shutdownRecheckDeadlineMs(timer, deadlineMs, strictDeadline);
  const discovery = await getShutdownDiscovery(
    { deviceManager, device, timer, deadlineMs: recheckDeadlineMs, requestAbortSignal, timeoutMs },
    skipAndroidNameEnrichment,
  );
  const replacement = findDiscoveredDevice(discovery, device);
  if (
    replacement &&
    (device.platform === "ios" || isConfirmedDeviceReplacement(device, replacement))
  ) {
    return replacement;
  }
  if (!replacement && discovery.succeededPlatforms.has(device.platform)) {
    return undefined;
  }
  return await waitForDeviceShutdown(
    { deviceManager, device, timer, deadlineMs: recheckDeadlineMs, requestAbortSignal, timeoutMs },
    skipAndroidNameEnrichment,
  );
}

interface ShutdownOwnershipContext {
  sessionManager?: SessionManager;
  sessionId?: string;
  device: BootedDevice;
  expectedPooledDevice: PooledDevice | null;
  expectedSession: Session | undefined;
  deviceManager: PlatformDeviceManager;
  timer: Timer;
  deadlineMs: number;
  requestAbortSignal: AbortSignal | undefined;
  stopPerformanceMonitoring: (deviceId: string) => void;
  retainReservationUntil: (retirement: Promise<void>) => void;
}

type ShutdownSessionOwnershipContext = ShutdownOwnershipContext & {
  sessionManager: SessionManager;
  sessionId: string;
};

type ShutdownEntryContext = Pick<
  ShutdownOwnershipContext,
  "device" | "timer" | "deadlineMs" | "requestAbortSignal" | "stopPerformanceMonitoring"
>;

interface ShutdownRetirementOptions {
  retryAfterDiscoveryFailure?: boolean;
  strictDeadline?: boolean;
  timeoutMs?: number;
  terminalReleaseRetriesRemaining?: number;
  skipAndroidNameEnrichment?: boolean;
}

function finishLateShutdownRetirement(
  context: ShutdownOwnershipContext,
  release: Promise<string | null>,
  observedReplacement: BootedDevice | undefined,
  terminalReleaseRetriesRemaining: number,
  skipAndroidNameEnrichment: boolean,
  disappearanceConfirmed: boolean,
): void {
  const { device, timer, retainReservationUntil } = context;
  const continueRetirement = async () => {
    await retireShutdownOwnership(
      { ...context, requestAbortSignal: undefined },
      observedReplacement,
      disappearanceConfirmed,
      {
        retryAfterDiscoveryFailure: true,
        strictDeadline: false,
        timeoutMs: DEVICE_SHUTDOWN_TIMEOUT_MS,
        terminalReleaseRetriesRemaining: DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
        skipAndroidNameEnrichment,
      },
    );
  };
  const retryRetirement = async (error: unknown) => {
    if (terminalReleaseRetriesRemaining <= 0) {
      throw error;
    }
    await timer.sleep(DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS);
    await retireShutdownOwnership(
      { ...context, requestAbortSignal: undefined },
      observedReplacement,
      disappearanceConfirmed,
      {
        retryAfterDiscoveryFailure: false,
        strictDeadline: false,
        timeoutMs: DEVICE_SHUTDOWN_TIMEOUT_MS,
        terminalReleaseRetriesRemaining: terminalReleaseRetriesRemaining - 1,
        skipAndroidNameEnrichment,
      },
    );
  };
  const lateRetirement = release.then(continueRetirement, retryRetirement);
  lateRetirement.catch((lateError) => {
    logger.warn(
      `[DeviceTools] Failed to finish late shutdown retirement for ${device.deviceId}: ${lateError}`,
    );
  });
  retainReservationUntil(lateRetirement);
}

async function findReplacementOrRetainShutdownReservation(
  context: ShutdownOwnershipContext,
  observedReplacement: BootedDevice | undefined,
  retryAfterFailure: boolean,
  disappearanceConfirmed: boolean,
  strictDeadline: boolean,
  options: { timeoutMs: number; skipAndroidNameEnrichment: boolean },
): Promise<BootedDevice | undefined> {
  const { timeoutMs, skipAndroidNameEnrichment } = options;
  const { device, expectedPooledDevice, timer, stopPerformanceMonitoring, retainReservationUntil } =
    context;
  try {
    return (
      observedReplacement ??
      (await findReplacementAfterSessionRelease(
        context,
        strictDeadline,
        timeoutMs,
        skipAndroidNameEnrichment,
      ))
    );
  } catch (error) {
    // Only this post-release discovery operation is retried. A failure from
    // releaseSessionOwnership never reaches this catch and still retains the
    // reservation until persistence succeeds.
    logger.warn(`[DeviceTools] Post-release discovery failed for ${device.deviceId}: ${error}`);
    if (!disappearanceConfirmed) {
      // Teardown has not confirmed disappearance. A failed recheck cannot
      // authorize retirement. Ownership release has settled, so let the
      // caller's finally release the reservation while leaving the entry intact.
      throw error;
    }
    if (retryAfterFailure) {
      const retirement = timer
        .sleep(DEVICE_SHUTDOWN_DISCOVERY_RECHECK_BACKOFF.delayForAttempt(1))
        .then(async () => {
          await retireShutdownOwnership(
            { ...context, requestAbortSignal: undefined, retainReservationUntil: () => undefined },
            observedReplacement,
            disappearanceConfirmed,
            {
              retryAfterDiscoveryFailure: false,
              strictDeadline: false,
              timeoutMs: DEVICE_SHUTDOWN_TIMEOUT_MS,
              terminalReleaseRetriesRemaining: DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
              skipAndroidNameEnrichment,
            },
          );
        });
      retirement.catch((lateError) => {
        logger.warn(
          `[DeviceTools] Retaining shutdown reservation after retirement failed for ${device.deviceId}: ${lateError}`,
        );
      });
      retainReservationUntil(retirement);
      throw error;
    }
    // Disappearance was already confirmed and ownership released. The exact
    // captured incarnation guard makes retirement safe after a second failed
    // recheck, while preserving a newer same-serial pool entry.
    const ownership = captureCurrentShutdownPooledOwnership(device, expectedPooledDevice);
    if (
      ownership &&
      (await ownership.devicePool.retireDeviceForShutdown(ownership.expectedPooledDevice, {
        excludeExecutionId: getShutdownInitiatingExecutionId(),
      }))
    ) {
      stopPerformanceMonitoring(device.deviceId);
    }
    return undefined;
  }
}

function preserveLateShutdownRetirement(
  context: ShutdownSessionOwnershipContext,
  error: unknown,
  release: Promise<string | null>,
  observedReplacement: BootedDevice | undefined,
  options: {
    terminalReleaseRetriesRemaining: number;
    skipAndroidNameEnrichment: boolean;
    disappearanceConfirmed: boolean;
  },
): void {
  const { device, requestAbortSignal, sessionManager, sessionId } = context;
  const { terminalReleaseRetriesRemaining, skipAndroidNameEnrichment, disappearanceConfirmed } =
    options;
  if (
    !isShutdownTimeoutError(error) &&
    !requestAbortSignal?.aborted &&
    sessionManager.getSessionForDevice(device.deviceId) === sessionId &&
    !sessionManager.getTerminalReleaseSnapshot(sessionId)
  ) {
    return;
  }
  // Session release either removed its in-memory mapping or terminally fenced
  // the UUID before a durable write failed. It cannot be cancelled safely, so
  // keep the captured shutdown reservation until the late release finishes its
  // identity-guarded retirement. Otherwise a stopped device could remain as a
  // busy ghost in the pool.
  finishLateShutdownRetirement(
    context,
    release,
    observedReplacement,
    terminalReleaseRetriesRemaining,
    skipAndroidNameEnrichment,
    disappearanceConfirmed,
  );
}

async function releaseShutdownSessionOwnership(
  context: ShutdownOwnershipContext,
  daemonState: DaemonState,
  observedReplacement: BootedDevice | undefined,
  strictDeadline: boolean,
  options: {
    timeoutMs: number;
    terminalReleaseRetriesRemaining: number;
    disappearanceConfirmed: boolean;
    skipAndroidNameEnrichment: boolean;
  },
): Promise<void> {
  const { device, expectedSession, timer, deadlineMs, requestAbortSignal } = context;
  const {
    timeoutMs,
    terminalReleaseRetriesRemaining,
    disappearanceConfirmed,
    skipAndroidNameEnrichment,
  } = options;
  const sessionManager = daemonState.getSessionManager();
  const sessionId = expectedSession?.sessionId;
  if (!sessionId || expectedSession.assignedDevice !== device.deviceId) {
    return;
  }

  await executionTracker.cancelSessionUuidExecutions(
    sessionId,
    deviceLossCancellationReason(device.deviceId),
    { excludeExecutionId: getShutdownInitiatingExecutionId() },
  );
  const release = sessionManager.releaseSessionIfOwned(
    sessionId,
    expectedSession,
    device.deviceId,
    "device-killed",
  );
  try {
    await runWithinShutdownDeadline(
      device,
      timer,
      shutdownRecheckDeadlineMs(timer, deadlineMs, strictDeadline),
      "session ownership retirement did not complete",
      {
        requestAbortSignal: requestAbortSignal,
        operation: async () => await release,
        timeoutMs: timeoutMs,
      },
    );
  } catch (error) {
    preserveLateShutdownRetirement(
      { ...context, sessionManager, sessionId },
      error,
      release,
      observedReplacement,
      { terminalReleaseRetriesRemaining, skipAndroidNameEnrichment, disappearanceConfirmed },
    );
    throw error;
  }
}

function captureCurrentShutdownPooledOwnership(
  device: BootedDevice,
  expectedPooledDevice: PooledDevice | null,
):
  | { daemonState: DaemonState; devicePool: DevicePool; expectedPooledDevice: PooledDevice }
  | undefined {
  if (!expectedPooledDevice) {
    return undefined;
  }
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return undefined;
  }
  const devicePool = daemonState.getDevicePool();
  // A fast reboot can reuse a serial. Do not release or remove a later pool
  // incarnation that happens to use the same device ID.
  if (devicePool.getDevice(device.deviceId) !== expectedPooledDevice) {
    return undefined;
  }
  return { daemonState, devicePool, expectedPooledDevice };
}

export async function retireShutdownOwnership(
  context: ShutdownOwnershipContext,
  observedReplacement: BootedDevice | undefined,
  disappearanceConfirmed: boolean,
  options: ShutdownRetirementOptions = {},
): Promise<void> {
  const { device, expectedPooledDevice, stopPerformanceMonitoring } = context;
  const {
    retryAfterDiscoveryFailure = true,
    strictDeadline = false,
    timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
    terminalReleaseRetriesRemaining = DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
    skipAndroidNameEnrichment = false,
  } = options;
  const ownership = captureCurrentShutdownPooledOwnership(device, expectedPooledDevice);
  if (!ownership) {
    return;
  }
  const { daemonState, devicePool, expectedPooledDevice: capturedPooledDevice } = ownership;

  await releaseShutdownSessionOwnership(
    { ...context, expectedPooledDevice: capturedPooledDevice },
    daemonState,
    observedReplacement,
    strictDeadline,
    {
      timeoutMs,
      terminalReleaseRetriesRemaining,
      disappearanceConfirmed,
      skipAndroidNameEnrichment,
    },
  );
  if (devicePool.getDevice(device.deviceId) !== capturedPooledDevice) {
    return;
  }

  // A same-ID replacement can boot while releasing the old session. If so,
  // retire only the captured incarnation, then immediately rediscover the
  // replacement so it owns a fresh pool and registry epoch. Once shutdown was
  // observed, a bounded post-release recheck protects against a replacement
  // that boots at the disappearance deadline.
  const replacement = await findReplacementOrRetainShutdownReservation(
    { ...context, expectedPooledDevice: capturedPooledDevice },
    observedReplacement,
    retryAfterDiscoveryFailure,
    disappearanceConfirmed,
    strictDeadline,
    { timeoutMs, skipAndroidNameEnrichment },
  );
  if (replacement) {
    await rebuildSameIdReplacement(
      device,
      capturedPooledDevice,
      replacement,
      daemonState,
      stopPerformanceMonitoring,
    );
    return;
  }
  if (devicePool.getDevice(device.deviceId) !== capturedPooledDevice) {
    return;
  }
  if (
    await devicePool.retireDeviceForShutdown(capturedPooledDevice, {
      excludeExecutionId: getShutdownInitiatingExecutionId(),
    })
  ) {
    stopPerformanceMonitoring(device.deviceId);
  }
}

/**
 * Resolve the device the platform kill command is actually issued against.
 *
 * Without a pooled capture that is the caller's own target. With one -- an
 * emulator whose discovered name is `Unknown (<serial>)` -- the captured epoch
 * is re-confirmed and the runtime is asked to name itself, and the kill runs
 * under the name the runtime gave.
 *
 * Under `force` (#6864) the runtime is not asked, so there is no name to run
 * under and the caller's target is used unchanged. That is not a detail:
 * `AndroidEmulatorClient.killDevice` re-discovers the serial and refuses a
 * target whose name differs from the discovered one, so substituting the
 * unconfirmed pooled label here would make the forced kill refuse itself on
 * exactly the wedged console the flag exists for.
 *
 * Called FIRST inside the shutdown's execute step, after the shutdown
 * reservation (so the pool cannot evict the captured entry mid-check) but
 * BEFORE any of the shutdown's preparation side effects. A refusal here is a
 * statement that this daemon may not touch the device at all, so it must not
 * arrive with the device's recordings already stopped, its CtrlProxy singleton
 * closed and removed, and its passive observers detached -- those are not
 * rolled back, and the device is still running
 * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
 */
async function resolvePooledAvdKillTarget(
  dependencies: DeviceToolsDependencies,
  device: BootedDevice,
  pooledAvdIdentity: PooledAvdKillIdentity | undefined,
  devicePool: DevicePool | undefined,
  shutdownDeadlineMs: number,
  requestAbortSignal: AbortSignal | undefined,
): Promise<BootedDevice> {
  if (!pooledAvdIdentity?.capture) {
    return device;
  }
  const confirmation = await confirmPooledAvdIdentity(
    device,
    pooledAvdIdentity.capture,
    devicePool,
    dependencies.resolveRunningAndroidAvdName,
    { timer: dependencies.timer, deadlineMs: shutdownDeadlineMs, signal: requestAbortSignal },
    pooledAvdIdentity.force,
  );
  if (confirmation.kind === "refusal") {
    throw new PooledAvdIdentityError(pooledAvdNameRefusalMessage(device, confirmation.refusal));
  }
  return confirmation.kind === "skipped"
    ? device
    : { ...device, name: confirmation.confirmedAvdName };
}

interface KillProcessAndRetireOwnershipOptions {
  androidObserverState: AndroidObserverShutdownState;
  releaseShutdownReservation: () => Promise<void>;
  strictDeadline: boolean;
  timeoutMs: number;
  killTarget: BootedDevice;
  /**
   * Required rather than defaulted: this is the one function that hands the
   * caller's #6864 escape hatch to the platform kill, and a default here counts
   * against the function's complexity ratchet for no benefit -- it has a single
   * call site.
   */
  force: boolean;
  retainReservationUntil: (
    retirement: Promise<void>,
    releaseReservationAfterFailure?: boolean,
  ) => void;
}

async function confirmIosShutdownAfterTimeout(
  context: ShutdownDiscoveryContext,
  error: unknown,
  platformCommandSettled: boolean,
): Promise<boolean> {
  if (
    context.device.platform !== "ios" ||
    !platformCommandSettled ||
    (!isShutdownTimeoutError(error) && !String(error).includes("Command timed out"))
  ) {
    return false;
  }
  // simctl accepted shutdown, then its state read consumed the last command
  // millisecond. Use a fresh, uncached observation and a dedicated budget.
  try {
    const discovery = await getShutdownDiscovery({
      ...context,
      deadlineMs: context.timer.now() + IOS_SHUTDOWN_CONFIRMATION_MIN_MS,
      timeoutMs: IOS_SHUTDOWN_CONFIRMATION_MIN_MS,
    });
    return (
      discovery.succeededPlatforms.has("ios") && !findDiscoveredDevice(discovery, context.device)
    );
  } catch (confirmationError) {
    logger.warn(
      `[DeviceTools] iOS shutdown confirmation failed for ${context.device.deviceId}: ${confirmationError}`,
      confirmationError,
    );
    return false;
  }
}

async function handleUnconfirmedKillCommandError(
  error: unknown,
  context: ShutdownDiscoveryContext & {
    expectedPooledDevice: PooledDevice | null;
    devicePool: DevicePool | undefined;
    platformShutdown: Promise<BootedDevice | void> | undefined;
    platformShutdownSettled: boolean;
    retainReservationUntil: KillProcessAndRetireOwnershipOptions["retainReservationUntil"];
    releaseShutdownReservation: () => Promise<void>;
    androidObserverState: AndroidObserverShutdownState;
  },
): Promise<string | undefined> {
  const {
    device,
    devicePool,
    requestAbortSignal,
    expectedPooledDevice,
    platformShutdown,
    platformShutdownSettled,
    retainReservationUntil,
    releaseShutdownReservation,
    androidObserverState,
    deviceManager,
    timer,
    deadlineMs,
    timeoutMs,
  } = context;
  // A command that was never invoked cannot produce a late platform exit.
  const keepIntentionalShutdown =
    platformShutdown !== undefined &&
    shouldKeepIntentionalShutdownAfterCommandError(error, requestAbortSignal);
  retainLatePlatformShutdown(
    platformShutdown,
    platformShutdownSettled,
    retainReservationUntil,
    async () => {
      if (!keepIntentionalShutdown || !expectedPooledDevice || !devicePool) {
        return;
      }
      devicePool.noteLatePlatformShutdownSettled(expectedPooledDevice);
      // A late command failure cannot distinguish platform failure from cancellation.
    },
  );
  if (
    !keepIntentionalShutdown &&
    !isAlreadyStoppedDeviceError(device.platform, device.deviceId, error)
  ) {
    devicePool?.clearIntentionalShutdown(device.deviceId);
    await releaseShutdownReservation();
  }
  await resumeCtrlProxyAfterUnconfirmedFailure(device, error, requestAbortSignal);
  await restoreAndroidObserverAfterCommandFailure(
    { deviceManager, device, timer, shutdownDeadlineMs: deadlineMs, requestAbortSignal, timeoutMs },
    androidObserverState,
    error,
  );
  return handleShutdownCommandError(device, error, devicePool, keepIntentionalShutdown);
}

async function killProcessAndRetireOwnership(
  context: ShutdownEntryContext &
    Pick<
      ShutdownOwnershipContext,
      "expectedPooledDevice" | "expectedSession" | "retainReservationUntil"
    >,
  dependencies: DeviceToolsDependencies,
  perf: ReturnType<typeof createPerformanceTracker>,
  devicePool: DevicePool | undefined,
  options: KillProcessAndRetireOwnershipOptions,
): Promise<string | undefined> {
  const { device, expectedPooledDevice, requestAbortSignal } = context;
  const {
    androidObserverState,
    releaseShutdownReservation,
    strictDeadline,
    timeoutMs,
    killTarget,
    force,
    retainReservationUntil,
  } = options;
  const shutdownDeadlineMs = context.deadlineMs;
  const deviceManager = dependencies.deviceManagerFactory();
  if (device.platform === "android") {
    devicePool?.markIntentionalShutdown(device.deviceId);
  }

  let shutdownDevice = device;
  let alreadyStoppedMessage: string | undefined;
  let confirmedAfterCommandError = false;
  let platformShutdown: Promise<BootedDevice | void> | undefined;
  let platformShutdownSettled = false;
  perf.startOperation("killProcess");
  try {
    const killedDevice = await runWithinShutdownDeadline(
      device,
      dependencies.timer,
      shutdownDeadlineMs,
      "platform shutdown command did not complete",
      {
        requestAbortSignal: requestAbortSignal,
        operation: async (signal, timeoutMs) => {
          platformShutdown = deviceManager
            .killDevice(killTarget, { signal, timeoutMs, force })
            .finally(() => {
              platformShutdownSettled = true;
            });
          return await platformShutdown;
        },
        timeoutMs: timeoutMs,
      },
    );
    shutdownDevice = killedDevice ?? device;
  } catch (error) {
    confirmedAfterCommandError = await confirmIosShutdownAfterTimeout(
      {
        deviceManager,
        device,
        timer: dependencies.timer,
        deadlineMs: shutdownDeadlineMs,
        requestAbortSignal,
        timeoutMs,
      },
      error,
      platformShutdownSettled,
    );
    if (!confirmedAfterCommandError) {
      alreadyStoppedMessage = await handleUnconfirmedKillCommandError(error, {
        deviceManager,
        device,
        timer: dependencies.timer,
        deadlineMs: shutdownDeadlineMs,
        requestAbortSignal,
        timeoutMs,
        expectedPooledDevice,
        devicePool,
        platformShutdown,
        platformShutdownSettled,
        retainReservationUntil,
        releaseShutdownReservation,
        androidObserverState,
      });
    }
  }
  perf.endOperation("killProcess");

  if (alreadyStoppedMessage !== undefined) {
    return alreadyStoppedMessage;
  }

  let shutdownWasConfirmed = false;
  try {
    perf.startOperation("waitForShutdown");
    const confirmationDeadlineMs =
      device.platform === "ios"
        ? Math.max(shutdownDeadlineMs, dependencies.timer.now() + IOS_SHUTDOWN_CONFIRMATION_MIN_MS)
        : shutdownDeadlineMs;
    const observedReplacement = confirmedAfterCommandError
      ? undefined
      : await waitForDeviceShutdown(
          {
            deviceManager,
            device: shutdownDevice,
            timer: dependencies.timer,
            deadlineMs: confirmationDeadlineMs,
            requestAbortSignal,
            timeoutMs,
          },
          force,
        );
    perf.endOperation("waitForShutdown");
    shutdownWasConfirmed = true;

    perf.startOperation("retireOwnership");
    await retireShutdownOwnership(
      { ...context, device: shutdownDevice, deviceManager },
      observedReplacement,
      true,
      {
        retryAfterDiscoveryFailure: true,
        strictDeadline,
        timeoutMs,
        terminalReleaseRetriesRemaining: DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
        skipAndroidNameEnrichment: force,
      },
    );
    perf.endOperation("retireOwnership");
    return undefined;
  } catch (error) {
    await recoverAfterShutdownFailure(
      device,
      error,
      requestAbortSignal,
      devicePool,
      releaseShutdownReservation,
      shutdownWasConfirmed,
    );
    throw error;
  }
}

function retainLatePlatformShutdown(
  platformShutdown: Promise<BootedDevice | void> | undefined,
  platformShutdownSettled: boolean,
  retainReservationUntil: (
    retirement: Promise<void>,
    releaseReservationAfterFailure?: boolean,
  ) => void,
  onSettled: (error?: unknown) => Promise<void>,
): void {
  if (!platformShutdown) {
    return;
  }
  const settlement = platformShutdown.then(
    () => onSettled(),
    async (error) => {
      await onSettled(error);
      throw error;
    },
  );
  if (platformShutdownSettled) {
    void settlement.catch((error) => {
      logger.debug(`[DeviceTools] Late platform shutdown had already settled: ${error}`);
      // The command failure was already handled by the caller; no reservation remains here.
    });
  } else {
    retainReservationUntil(settlement, true);
  }
}

interface ShutdownResult {
  timing: unknown;
  alreadyStoppedMessage?: string;
}

const deviceShutdownService = new DeviceShutdownService();

async function finishShutdownCleanup(
  shutdownContext: ShutdownDeadlineContext,
  dependencies: DeviceToolsDependencies,
  perf: ReturnType<typeof createPerformanceTracker>,
  options: {
    strictDeadline: boolean;
    timeoutMs: number;
    retiredIncarnation: number;
  },
): Promise<void> {
  const { device } = shutdownContext;
  const { strictDeadline, timeoutMs, retiredIncarnation } = options;
  const cleanup = clearInstalledAppsAfterShutdown(dependencies, device.deviceId);
  const notification = cleanup.then(async () => {
    await notifyResourcesAfterShutdown(dependencies);
  });
  const release = cleanup.then(async (cacheCleared) => {
    // Failed persistence must keep the dirty fence across device-ID reuse.
    if (!cacheCleared) {
      return;
    }
    // Prefer releasing after the notification's own re-invalidation has
    // been queued, but never wait on it unboundedly: a notifier that
    // never settles must not retain this device's bookkeeping forever.
    await settleWithin(notification, dependencies.timer, timeoutMs);
    await getInstalledAppsCacheWriteCoordinator().releaseDevice(
      device.deviceId,
      retiredIncarnation,
    );
  });
  // Keep late cleanup visible to DB shutdown without blocking a later
  // device teardown retry if resource notification never settles.
  void getDbWriteBarrier().trackExisting(notification);
  void getDbWriteBarrier().trackExisting(release);

  await runPostShutdownStep(
    shutdownContext,
    perf,
    "cleanup",
    "installed-app cleanup did not complete",
    strictDeadline,
    async () => {
      await cleanup;
    },
  );
  await runPostShutdownStep(
    shutdownContext,
    perf,
    "notifyResources",
    "resource notification did not complete",
    strictDeadline,
    async () => await notification,
  );
}

export async function shutdownDevice(
  context: ShutdownEntryContext,
  dependencies: DeviceToolsDependencies,
  operationName: string,
  options: {
    strictDeadline: boolean;
    timeoutMs: number;
    retainLifecycleUntil?: (operation: Promise<unknown>) => void;
    pooledAvdIdentity?: PooledAvdKillIdentity;
    /** Re-checks the caller still holds the device; runs under the pool's assignment mutex. */
    assertHolder?: () => void;
  },
): Promise<ShutdownResult> {
  const { strictDeadline, timeoutMs, retainLifecycleUntil, pooledAvdIdentity, assertHolder } =
    options;
  const { device, requestAbortSignal } = context;
  const shutdownDeadlineMs = context.deadlineMs;
  const perf = createPerformanceTracker(true);
  perf.serial(operationName);
  const daemonState = DaemonState.getInstance();
  const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
  let expectedSession: Session | undefined;
  // Ambient scope (only under --debug-perf) so the adb/emulator-console/simctl
  // commands issued while tearing the device down attribute their time into this
  // shutdown tree (see PerfContext).
  return await runWithPerfTracker(ambientPerfFor(perf), () =>
    deviceShutdownService.shutdown({
      prepare: async () => {
        const reservation = await runWithinShutdownDeadline(
          device,
          dependencies.timer,
          shutdownDeadlineMs,
          "shutdown preparation did not complete",
          {
            requestAbortSignal: requestAbortSignal,
            operation: async (signal) =>
              await devicePool?.reserveDeviceForShutdown(
                device.deviceId,
                signal,
                undefined,
                assertHolder,
              ),
            timeoutMs: timeoutMs,
          },
        );
        expectedSession = reservation?.session;
        return reservation;
      },
      execute: async (shutdownReservation, retainReservationUntil) => {
        const releaseShutdownReservation = async (): Promise<void> => {
          try {
            await shutdownReservation?.release();
          } catch (error) {
            // Release is best-effort cleanup and must not replace the shutdown outcome.
            logger.warn(
              `[DeviceTools] Failed to release shutdown reservation for ${device.deviceId}: ${errorMessage(error)}`,
              error,
            );
          }
        };
        const expectedPooledDevice = shutdownReservation?.device ?? null;
        const retainShutdownUntil = (
          operation: Promise<unknown>,
          releaseReservationAfterFailure = false,
        ): void => {
          retainReservationUntil(operation, releaseReservationAfterFailure);
          retainLifecycleUntil?.(operation);
        };
        const shutdownContext: ShutdownDeadlineContext = {
          device,
          timer: dependencies.timer,
          deadlineMs: shutdownDeadlineMs,
          timeoutMs,
          requestAbortSignal,
          retainReservationUntil: retainShutdownUntil,
        };
        // Identity first: a refusal must leave a still-running device untouched.
        const killTarget = await resolvePooledAvdKillTarget(
          dependencies,
          device,
          pooledAvdIdentity,
          devicePool,
          shutdownDeadlineMs,
          requestAbortSignal,
        );
        await stopVideoRecordingsBeforeShutdown(shutdownContext, perf);
        await stopIosCtrlProxyBeforeShutdown(shutdownContext, perf);
        const androidObserverState = await stopAndroidCtrlProxyBeforeShutdown(
          shutdownContext,
          perf,
          dependencies.stopAndroidObservers,
        );

        const alreadyStoppedMessage = await killProcessAndRetireOwnership(
          {
            ...context,
            expectedPooledDevice,
            expectedSession,
            retainReservationUntil: retainShutdownUntil,
          },
          dependencies,
          perf,
          devicePool,
          {
            androidObserverState,
            releaseShutdownReservation,
            retainReservationUntil: retainShutdownUntil,
            strictDeadline,
            timeoutMs,
            killTarget,
            force: pooledAvdIdentity?.force ?? false,
          },
        );

        if (alreadyStoppedMessage !== undefined) {
          // The target may have stopped between teardown discovery and the platform
          // kill command. Retire the captured pool incarnation before deletion.
          perf.startOperation("retireOwnership");
          await retireShutdownOwnership(
            {
              ...context,
              expectedPooledDevice,
              expectedSession,
              deviceManager: dependencies.deviceManagerFactory(),
              retainReservationUntil: retainShutdownUntil,
            },
            undefined,
            true,
            {
              retryAfterDiscoveryFailure: true,
              strictDeadline,
              timeoutMs,
              terminalReleaseRetriesRemaining: DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
              skipAndroidNameEnrichment: pooledAvdIdentity?.force ?? false,
            },
          );
          perf.endOperation("retireOwnership");
        }

        // Retire the installed-apps cache incarnation BEFORE the shutdown
        // reservation is released, i.e. before a same-ID replacement can boot
        // (#6894). From here on, work that captured this incarnation is fenced,
        // the replacement starts a fresh incarnation, and the late release below
        // binds to this token so it can never delete the replacement's fences.
        // Invalidations landing on the retired incarnation meanwhile (the
        // cleanup below, and notifyResourcesAfterShutdown() ->
        // syncInstalledAppResources() re-invalidating the same, already-gone
        // device) fence it without starting a phantom incarnation, so the
        // release still finds and frees the bookkeeping (#6704).
        const retiredIncarnation = getInstalledAppsCacheWriteCoordinator().retireIncarnation(
          device.deviceId,
        );
        await releaseShutdownReservation();
        unregisterDirectSessionsForDevice(device.deviceId);

        await finishShutdownCleanup(shutdownContext, dependencies, perf, {
          strictDeadline,
          timeoutMs,
          retiredIncarnation,
        });

        perf.end();
        return {
          timing: perf.getTimings(),
          alreadyStoppedMessage,
        };
      },
      failure: (error) => rethrowShutdownFailure(device, requestAbortSignal, error),
    }),
  );
}
