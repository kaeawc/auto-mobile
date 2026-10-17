import { isEmulatorStopDispatchedError } from "../utils/android-cmdline-tools/EmulatorProcessStop";
import { ctrlProxyClientLifecycle } from "../features/observe/ctrlProxyClientLifecycle";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { ActionableError, type BootedDevice, type SomePlatform } from "../models";
import type { DeviceShutdownOptions, PlatformDeviceManager } from "../devices/deviceUtils";
import type { Timer } from "../utils/SystemTimer";
import { DaemonState } from "../daemon/daemonState";
import type {
  DevicePool,
  PooledDevice,
  ShutdownForeignClaim,
  RestartStopIdentity,
} from "../daemon/devicePool";
import type { Session } from "../daemon/sessionManager";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { ambientPerfFor, runWithPerfTracker } from "../utils/PerfContext";
import {
  resolveDirectSessionDevice,
  unregisterDirectSessionsForDevice,
} from "./directSessionDeviceRegistry";
import { getInstalledAppsCacheWriteCoordinator } from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";
import { DeviceShutdownService } from "../devices/deviceShutdownService";
import { isAdbMissingDeviceError } from "../utils/android-cmdline-tools/AdbDeviceHealth";
import { isIosSimulatorAlreadyStoppedError } from "../utils/ios-cmdline-tools/simulatorStateErrors";
import {
  DEVICE_ALREADY_STOPPED_ERROR_CODE,
  DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
  DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
  DeviceToolsDependencies,
  KillDeviceArgs,
  PooledAvdIdentityError,
  PooledAvdKillIdentity,
  ShutdownDeadlineContext,
  ShutdownDiscoveryContext,
  ShutdownOwnershipContext,
  confirmPooledAvdIdentity,
  createToolErrorResponse,
  findDiscoveredDevice,
  getShutdownDiscovery,
  hasUnresolvedEmulatorRuntimeName,
  isShutdownTimeoutError,
  isUnknownAndroidRuntimeName,
  notifyResourcesAfterShutdown,
  pooledAvdNameRefusalMessage,
  retireShutdownOwnership,
  runWithinShutdownDeadline,
  settleWithin,
  shouldClearIntentionalShutdownAfterFailure,
  shouldPropagateShutdownPreparationError,
  shutdownTimeoutError,
  stopVideoRecordingsBeforeShutdown,
  waitForDeviceShutdown,
} from "../features/deviceLifecycle/deviceLifecycleCore";
export {
  DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
  isShutdownTimeoutError,
  shutdownTimeoutError,
  getShutdownInitiatingExecutionId,
  DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
  retireShutdownOwnership,
  waitForDeviceShutdown,
  type ShutdownDiscoveryContext,
  stopVideoRecordingsBeforeShutdown,
  type ShutdownDeadlineContext,
  shouldClearIntentionalShutdownAfterFailure,
} from "../features/deviceLifecycle/deviceLifecycleCore";

const IOS_SHUTDOWN_CONFIRMATION_MIN_MS = 2_000;

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
    return isIosSimulatorAlreadyStoppedError(error);
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
        message: `ios '${deviceDisplayName(args.device)}' already shut down`,
        udid: args.device.deviceId,
        name: deviceDisplayName(args.device),
        timing,
        platform: args.device.platform,
      });
    }
    return createToolErrorResponse(DEVICE_ALREADY_STOPPED_ERROR_CODE, alreadyStoppedMessage);
  }

  return createStructuredToolResponse({
    message: `${args.device.platform} '${deviceDisplayName(args.device)}' shutdown successfully`,
    udid: args.device.deviceId,
    name: deviceDisplayName(args.device),
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

interface AndroidObserverShutdownState {
  hadActiveObserver: boolean;
  boundSessionId: string | null;
  deviceIdentity: BootedDevice | null;
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

async function resumeCtrlProxyAfterFailedKill(device: BootedDevice): Promise<void> {
  const daemonState = DaemonState.getInstance();
  if (
    daemonState.isInitialized() &&
    (await daemonState.getDevicePool().isShutdownReserved(device.deviceId))
  ) {
    return;
  }
  ctrlProxyClientLifecycle.resumeAfterDeviceStart(device.platform, device.deviceId);
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
  return (
    requestAbortSignal?.aborted === true ||
    isShutdownTimeoutError(error) ||
    isEmulatorStopDispatchedError(error)
  );
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

type ShutdownEntryContext = Pick<
  ShutdownOwnershipContext,
  "device" | "timer" | "deadlineMs" | "requestAbortSignal" | "stopPerformanceMonitoring"
>;

/**
 * Resolve the device the platform kill command is actually issued against.
 *
 * Without a pooled capture that is the caller's own target. With one -- an
 * emulator whose discovered name is `Unknown (<serial>)` -- the captured epoch
 * is re-confirmed and the runtime is asked to name itself, and the kill runs
 * under the name the runtime gave.
 *
 * For an ordinary stop, `force` (#6864) skips this probe and preserves the
 * caller's target. A restart hold still requires the separately confirmed
 * identity passed by lifecycle admission; force never skips that confirmation.
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
  budget: Pick<ShutdownEntryContext, "deadlineMs" | "requestAbortSignal">,
  assertStopIdentity?: (stopIdentity?: RestartStopIdentity) => void,
): Promise<BootedDevice> {
  if (!pooledAvdIdentity?.capture) {
    return device;
  }
  const confirmation = await confirmPooledAvdIdentity(
    device,
    pooledAvdIdentity.capture,
    devicePool,
    dependencies.resolveRunningAndroidAvdName,
    {
      timer: dependencies.timer,
      deadlineMs: budget.deadlineMs,
      signal: budget.requestAbortSignal,
      processStopper: dependencies.androidEmulatorProcessStopper,
    },
    pooledAvdIdentity.force,
  ).catch((error: unknown) => {
    logger.warn(`[DeviceTools] Pooled stop identity probe failed for ${device.deviceId}`, error);
    assertStopIdentity?.({ unconfirmed: true });
    throw error;
  });
  if (confirmation.kind === "refusal") {
    // Discovery lost identity evidence after admission; the restart guard must see that too.
    assertStopIdentity?.(
      confirmation.refusal.reason === "conflict"
        ? { confirmed: confirmation.refusal.runtimeAvdName }
        : { unconfirmed: true },
    );
    throw new PooledAvdIdentityError(pooledAvdNameRefusalMessage(device, confirmation.refusal));
  }
  return confirmation.kind === "skipped"
    ? device
    : withConfirmedName(device, confirmation.confirmedAvdName);
}

/**
 * The kill target renamed to a confirmed identity. A blank confirmation is no identity at all,
 * so the caller's own target stays: renaming to '' made the kill report "Emulator '' is not
 * running" and defeated the name comparison downstream.
 */
export function withConfirmedName(device: BootedDevice, confirmed: string): BootedDevice {
  return confirmed.trim() === "" ? device : { ...device, name: confirmed };
}

/** A name for messages: the caller's name, or the serial when the name is blank. */
function deviceDisplayName(device: BootedDevice): string {
  return device.name.trim() === "" ? device.deviceId : device.name;
}

interface KillProcessAndRetireOwnershipOptions {
  processStop?: DeviceShutdownOptions["processStop"];
  stoppingSessionUuid?: string;
  stoppingMcpSessionId?: string;
  stableIds?: readonly string[];
  stopIdentity?: RestartStopIdentity;
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

/** Confirmed stops await a bounded terminal write attempt; persistence cannot undo the stop. */
export async function commitStoppedRestartHold(
  context: Pick<ShutdownEntryContext, "device" | "deadlineMs">,
  dependencies: Pick<DeviceToolsDependencies, "timer">,
  commit: (() => void | Promise<void>) | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!commit) {
    return;
  }
  try {
    const attempt = Promise.resolve(commit());
    await runWithinShutdownDeadline(
      context.device,
      dependencies.timer,
      context.deadlineMs,
      "restart holder terminal write did not complete",
      {
        // Invoke before racing: even a spent shutdown budget must attempt the durable write.
        requestAbortSignal: undefined,
        operation: async () => await attempt,
        timeoutMs,
      },
    );
  } catch (error) {
    logger.warn(
      `[DeviceTools] Stopped device ${context.device.deviceId} restart holder write failed: ${error}`,
      error,
    );
  }
}

function androidKillProcessStop(
  dependencies: DeviceToolsDependencies,
  device: BootedDevice,
  identity: PooledAvdKillIdentity | undefined,
): DeviceShutdownOptions["processStop"] {
  return device.platform === "android"
    ? {
        stopper: dependencies.androidEmulatorProcessStopper,
        expectedAvdName: identity?.capture?.avdName,
      }
    : undefined;
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
    processStop,
    retainReservationUntil,
  } = options;
  const shutdownDeadlineMs = context.deadlineMs;
  const deviceManager = dependencies.deviceManagerFactory();
  // A failed/cancelled/timed-out call never commits, including a late platform settlement:
  // the unchanged restart hold remains governed by its original recovery window.
  const captureRestartHold =
    device.platform === "android"
      ? "markIntentionalShutdown"
      : "releaseDeviceRestartReservationForStop";
  const commitRestartHoldStop = devicePool?.[captureRestartHold](
    device.deviceId,
    options.stoppingSessionUuid,
    {
      mcpSessionId: options.stoppingMcpSessionId,
      platform: device.platform,
      stableIds: options.stableIds,
      stopIdentity: options.stopIdentity,
    },
  );

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
            .killDevice(killTarget, { signal, timeoutMs, force, processStop })
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
    await commitStoppedRestartHold(context, dependencies, commitRestartHoldStop, timeoutMs);
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
    await commitStoppedRestartHold(context, dependencies, commitRestartHoldStop, timeoutMs);

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

interface ShutdownDeviceOptions {
  strictDeadline: boolean;
  timeoutMs: number;
  stoppingSessionUuid?: string;
  stoppingMcpSessionId?: string;
  stableIds?: readonly string[];
  stopIdentity?: RestartStopIdentity;
  retainLifecycleUntil?: (operation: Promise<unknown>) => void;
  pooledAvdIdentity?: PooledAvdKillIdentity;
  /** Re-checks the caller still holds the device; runs under the pool's assignment mutex. */
  assertHolder?: (stopIdentity?: RestartStopIdentity) => void;
  /** Claim the device against other live daemons while it is stopped (#11200). */
  foreignClaim?: ShutdownForeignClaim;
}

/** Reuse entry evidence unless the existing pooled shutdown path performs a fresh probe. */
async function resolveRestartStopKillTarget(
  dependencies: DeviceToolsDependencies,
  context: ShutdownEntryContext,
  options: ShutdownDeviceOptions,
  devicePool: DevicePool | undefined,
): Promise<{ killTarget: BootedDevice; stopIdentity: RestartStopIdentity | undefined }> {
  const { device } = context;
  const pooledKillTarget = await resolvePooledAvdKillTarget(
    dependencies,
    device,
    options.pooledAvdIdentity,
    devicePool,
    context,
    options.assertHolder,
  );
  // A kill-time re-probe supersedes entry evidence before any destructive preparation.
  const stopIdentity =
    pooledKillTarget !== device ? { confirmed: pooledKillTarget.name } : options.stopIdentity;
  if (pooledKillTarget !== device) {
    options.assertHolder?.(stopIdentity);
  }
  const killTarget =
    stopIdentity &&
    "confirmed" in stopIdentity &&
    (options.pooledAvdIdentity?.force || isUnknownAndroidRuntimeName(pooledKillTarget))
      ? withConfirmedName(pooledKillTarget, stopIdentity.confirmed)
      : pooledKillTarget;
  return { killTarget, stopIdentity };
}

export async function shutdownDevice(
  context: ShutdownEntryContext,
  dependencies: DeviceToolsDependencies,
  operationName: string,
  options: ShutdownDeviceOptions,
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
                options.foreignClaim,
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
        const { killTarget, stopIdentity } = await resolveRestartStopKillTarget(
          dependencies,
          context,
          options,
          devicePool,
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
            stoppingSessionUuid: options.stoppingSessionUuid,
            stoppingMcpSessionId: options.stoppingMcpSessionId,
            stableIds: options.stableIds,
            stopIdentity,
            releaseShutdownReservation,
            retainReservationUntil: retainShutdownUntil,
            strictDeadline,
            timeoutMs,
            killTarget,
            force: pooledAvdIdentity?.force ?? false,
            processStop: androidKillProcessStop(dependencies, device, pooledAvdIdentity),
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
