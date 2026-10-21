import type { Invalidatable, Reconnectable } from "./observerTypes";
import {
  isAlreadyStoppedDeviceError,
  resumeCtrlProxyWhenPreparationSettles,
  shouldKeepIntentionalShutdownAfterCommandError,
} from "./deviceToolsShutdownCtrlProxyResume";
import { ctrlProxyClientLifecycle } from "../features/observe/ctrlProxyClientLifecycle";
import { type BootedDevice } from "../models";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import type { Timer } from "../utils/SystemTimer";
import type { DaemonStateLike } from "../daemon/daemonState";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import { logger } from "../utils/logger";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { resolveDirectSessionDevice } from "../utils/directSessionDeviceRegistry";
import {
  DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
  ShutdownDeadlineContext,
  findDiscoveredDevice,
  getShutdownDiscovery,
  hasUnresolvedEmulatorRuntimeName,
  isShutdownTimeoutError,
  runWithinShutdownDeadline,
  shouldPropagateShutdownPreparationError,
  shutdownTimeoutError,
} from "../features/deviceLifecycle/deviceLifecycleCore";

export interface AndroidObserverShutdownState {
  hadActiveObserver: boolean;
  boundSessionId: string | null;
  deviceIdentity: BootedDevice | null;
}

export async function stopIosCtrlProxyBeforeShutdown(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool">,
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
      await ctrlProxyClientLifecycle.retireForShutdown("ios", context.device.deviceId);
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
      resumeCtrlProxyWhenPreparationSettles(stop, context.device, daemonState);
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

export async function stopAndroidCtrlProxyBeforeShutdown(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
  stopAndroidObservers: (device: BootedDevice) => Promise<void>,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool">,
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
      resumeCtrlProxyWhenPreparationSettles(stop, context.device, daemonState);
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
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getSessionManager">,
): boundSessionId is string {
  if (boundSessionId === null) {
    return false;
  }
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
  observer: Pick<AndroidCtrlProxyClient, "bindSession">,
  device: BootedDevice,
  observerState: AndroidObserverShutdownState,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getSessionManager">,
): void {
  if (
    hasLiveAndroidObserverSessionBinding(
      device,
      observerState.boundSessionId,
      observerState.deviceIdentity,
      daemonState,
    )
  ) {
    observer.bindSession(observerState.boundSessionId);
  }
}

function invalidateObserver(observer: Invalidatable, id: string): void {
  // Removal is deliberately synchronous and precedes cleanup. `close()` can
  // wait on an ADB forward removal that does not honour the shutdown deadline;
  // retaining the singleton until that completes would keep an obsolete client
  // (and the failed-shutdown reservation) alive indefinitely.
  observer.invalidateForShutdownRecovery();
  void observer.close().catch((error) => {
    logger.warn(
      `[DeviceTools] Failed to clean up invalidated Android observer for ${id}: ${error}`,
    );
  });
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
  observer: Reconnectable,
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
        invalidateObserver(observer, device.deviceId);
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
  observer: Invalidatable,
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
    invalidateObserver(observer, device.deviceId);
    throw error;
  }
}

export async function restoreAndroidObserverAfterCommandFailure(
  context: ShutdownObserverRecoveryContext,
  observerState: AndroidObserverShutdownState,
  error: unknown,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool" | "getSessionManager">,
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
      bindLiveAndroidObserverSession(observer, device, observerState, daemonState);
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
        invalidateObserver(observer, device.deviceId);
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
