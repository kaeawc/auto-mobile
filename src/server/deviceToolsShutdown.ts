import { createUnpooledFenceTracker } from "./unpooledShutdownFenceTracker";
import {
  isAlreadyStoppedDeviceError,
  resumeCtrlProxyAfterUnconfirmedFailure,
  shouldKeepIntentionalShutdownAfterCommandError,
} from "./deviceToolsShutdownCtrlProxyResume";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { ActionableError, type BootedDevice } from "../models";
import type { DeviceShutdownOptions } from "../devices/deviceUtils";
import type { DaemonStateLike } from "../daemon/daemonState";
import type {
  DevicePool,
  PooledDevice,
  ShutdownForeignClaim,
  RestartStopIdentity,
} from "../daemon/devicePool";
import type { Session } from "../daemon/sessionManager";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { ambientPerfFor, runWithPerfTracker } from "../utils/PerfContext";
import { unregisterDirectSessionsForDevice } from "../utils/directSessionDeviceRegistry";
import { getInstalledAppsCacheWriteCoordinator } from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";
import { DeviceShutdownService } from "../devices/deviceShutdownService";
import {
  DEVICE_ALREADY_STOPPED_ERROR_CODE,
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
  isShutdownTimeoutError,
  isUnknownAndroidRuntimeName,
  notifyResourcesAfterShutdown,
  pooledAvdNameRefusalMessage,
  retireShutdownOwnership,
  runWithinShutdownDeadline,
  settleWithin,
  shouldClearIntentionalShutdownAfterFailure,
  stopVideoRecordingsBeforeShutdown,
  waitForDeviceShutdown,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { waitForEmulatorShutdownWithEscalation } from "../features/deviceLifecycle/teardown/stuckEmulatorEscalation";
import { exponentialBackoff } from "../utils/Backoff";
import {
  AndroidObserverShutdownState,
  stopIosCtrlProxyBeforeShutdown,
  stopAndroidCtrlProxyBeforeShutdown,
  restoreAndroidObserverAfterCommandFailure,
} from "./deviceToolsShutdownObservers";

export {
  DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
  shutdownTimeoutError,
  retireShutdownOwnership,
  waitForDeviceShutdown,
} from "../features/deviceLifecycle/deviceLifecycleCore";

const IOS_SHUTDOWN_CONFIRMATION_MIN_MS = 2_000;
/** Pause between soft emulator-console re-sends while the guest ignores `emu kill` (#14018). */
const SOFT_KILL_RESEND_BACKOFF = exponentialBackoff({ initialDelayMs: 500, maxDelayMs: 2_000 });

export function createKillDeviceResponse(
  args: KillDeviceArgs,
  timing: unknown,
  alreadyStoppedMessage?: string,
) {
  if (alreadyStoppedMessage !== undefined) {
    // A simulator, iPhone or Apple Watch, that is already shut down is the requested end state.
    if (args.device.platform === "ios" || args.device.platform === "watchos") {
      return createStructuredToolResponse({
        message: `${args.device.platform} '${deviceDisplayName(args.device)}' already shut down`,
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
  failure: {
    device: BootedDevice;
    error: unknown;
    requestAbortSignal: AbortSignal | undefined;
    shutdownWasConfirmed: boolean;
  },
  devicePool: DevicePool | undefined,
  releaseShutdownReservation: () => Promise<void>,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool">,
): Promise<void> {
  const { device, error, requestAbortSignal, shutdownWasConfirmed } = failure;
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
  await resumeCtrlProxyAfterUnconfirmedFailure(device, error, requestAbortSignal, {
    daemonState,
    shutdownWasConfirmed,
  });
}

function rethrowShutdownFailure(
  device: BootedDevice,
  requestAbortSignal: AbortSignal | undefined,
  error: unknown,
): never {
  if (error instanceof ActionableError || requestAbortSignal?.aborted) {
    throw error;
  }
  throw new ActionableError(`Failed to kill ${device.platform} device: ${error}`, { cause: error });
}

async function runPostShutdownStep(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
  {
    operationName,
    detail,
    strictDeadline,
  }: { operationName: "cleanup" | "notifyResources"; detail: string; strictDeadline: boolean },
  operation: () => Promise<void>,
): Promise<void> {
  perf.startOperation(operationName);
  try {
    if (strictDeadline) {
      await runWithinShutdownDeadline(context.device, context.timer, context.deadlineMs, {
        detail,
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
  devicePool: DevicePool | undefined,
  {
    budget,
    pooledAvdIdentity,
    assertHolder: assertStopIdentity,
  }: Pick<ShutdownDeviceOptions, "pooledAvdIdentity" | "assertHolder"> & {
    budget: Pick<ShutdownEntryContext, "deadlineMs" | "requestAbortSignal">;
  },
): Promise<BootedDevice> {
  if (!pooledAvdIdentity?.capture) {
    return device;
  }
  const confirmation = await confirmPooledAvdIdentity(
    device,
    pooledAvdIdentity.capture,
    devicePool,
    {
      resolveRunningAvdName: dependencies.resolveRunningAndroidAvdName,
      budget: {
        timer: dependencies.timer,
        deadlineMs: budget.deadlineMs,
        signal: budget.requestAbortSignal,
        processStopper: dependencies.androidEmulatorProcessStopper,
      },
      force: pooledAvdIdentity.force,
    },
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
    daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool" | "getSessionManager">;
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
    daemonState,
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
  await resumeCtrlProxyAfterUnconfirmedFailure(device, error, requestAbortSignal, { daemonState });
  await restoreAndroidObserverAfterCommandFailure(
    { deviceManager, device, timer, shutdownDeadlineMs: deadlineMs, requestAbortSignal, timeoutMs },
    androidObserverState,
    error,
    daemonState,
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
    await runWithinShutdownDeadline(context.device, dependencies.timer, context.deadlineMs, {
      detail: "restart holder terminal write did not complete",
      // Invoke before racing: even a spent shutdown budget must attempt the durable write.
      requestAbortSignal: undefined,
      operation: async () => await attempt,
      timeoutMs,
    });
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

/**
 * Android emulators that ignore the soft console kill escalate to a process-level stop (#14018);
 * every other platform just waits for the device to leave discovery.
 */
async function confirmPlatformShutdown(
  options: ShutdownDiscoveryContext & {
    killTarget: BootedDevice;
    force: boolean;
    processStop: DeviceShutdownOptions["processStop"];
  },
): Promise<BootedDevice | undefined> {
  const { killTarget, force, processStop, ...discovery } = options;
  const context = {
    ...discovery,
    // simctl accepted shutdown; give the confirming observation its own minimum budget.
    deadlineMs:
      discovery.device.platform === "ios"
        ? Math.max(discovery.deadlineMs, discovery.timer.now() + IOS_SHUTDOWN_CONFIRMATION_MIN_MS)
        : discovery.deadlineMs,
  };
  if (!processStop) {
    return await waitForDeviceShutdown(context, force);
  }
  return await waitForEmulatorShutdownWithEscalation({
    context,
    skipAndroidNameEnrichment: force,
    stopper: processStop.stopper,
    avdName: isUnknownAndroidRuntimeName(killTarget)
      ? processStop.expectedAvdName
      : killTarget.name,
    backoff: SOFT_KILL_RESEND_BACKOFF,
    redispatchSoftKill: ({ timeoutMs }) =>
      context.deviceManager.killDevice(killTarget, {
        signal: context.requestAbortSignal,
        timeoutMs,
        force,
        processStop,
      }),
  });
}

async function killProcessAndRetireOwnership(
  context: ShutdownEntryContext &
    Pick<
      ShutdownOwnershipContext,
      "expectedPooledDevice" | "expectedSession" | "retainReservationUntil"
    >,
  dependencies: DeviceToolsDependencies,
  perf: ReturnType<typeof createPerformanceTracker>,
  {
    devicePool,
    options,
  }: { devicePool?: DevicePool; options: KillProcessAndRetireOwnershipOptions },
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
      {
        detail: "platform shutdown command did not complete",
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
        daemonState: dependencies.daemonState,
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
    const observedReplacement = confirmedAfterCommandError
      ? undefined
      : await confirmPlatformShutdown({
          deviceManager,
          device: shutdownDevice,
          timer: dependencies.timer,
          deadlineMs: shutdownDeadlineMs,
          requestAbortSignal,
          timeoutMs,
          killTarget,
          force,
          processStop,
        });
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
      { device, error, requestAbortSignal, shutdownWasConfirmed },
      devicePool,
      releaseShutdownReservation,
      dependencies.daemonState,
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
    {
      operationName: "cleanup",
      detail: "installed-app cleanup did not complete",
      strictDeadline,
    },
    async () => {
      await cleanup;
    },
  );
  await runPostShutdownStep(
    shutdownContext,
    perf,
    {
      operationName: "notifyResources",
      detail: "resource notification did not complete",
      strictDeadline,
    },
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
  const pooledKillTarget = await resolvePooledAvdKillTarget(dependencies, device, devicePool, {
    budget: context,
    ...options,
  });
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

async function preparePlatformShutdown(
  input: {
    dependencies: DeviceToolsDependencies;
    context: ShutdownEntryContext;
    options: ShutdownDeviceOptions;
    devicePool: DevicePool | undefined;
    shutdownContext: ShutdownDeadlineContext;
    perf: ReturnType<typeof createPerformanceTracker>;
  },
  clearFence: () => void,
) {
  const { dependencies, context, options, devicePool, shutdownContext, perf } = input;
  try {
    // Identity first: a refusal must leave a still-running device untouched.
    const target = await resolveRestartStopKillTarget(dependencies, context, options, devicePool);
    await stopVideoRecordingsBeforeShutdown(shutdownContext, perf);
    await stopIosCtrlProxyBeforeShutdown(shutdownContext, perf, dependencies.daemonState);
    const androidObserverState = await stopAndroidCtrlProxyBeforeShutdown(
      shutdownContext,
      perf,
      dependencies.stopAndroidObservers,
      dependencies.daemonState,
    );
    return { ...target, androidObserverState };
  } catch (error) {
    clearFence();
    throw error;
  }
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
  const { daemonState } = dependencies;
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
          {
            detail: "shutdown preparation did not complete",
            requestAbortSignal: requestAbortSignal,
            operation: async (signal) =>
              await devicePool?.reserveDeviceForShutdown(device.deviceId, signal, undefined, {
                assertHolder,
                foreignClaim: options.foreignClaim,
                fenceUnpooled: true,
              }),
            timeoutMs: timeoutMs,
          },
        );
        expectedSession = reservation?.session;
        return reservation;
      },
      execute: async (shutdownReservation, retainReservationUntil) => {
        const fence = createUnpooledFenceTracker(
          shutdownReservation ? undefined : devicePool,
          device.deviceId,
        );
        try {
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
          const retainShutdownUntil = fence.wrapRetain(
            (operation: Promise<unknown>, releaseReservationAfterFailure = false): void => {
              retainReservationUntil(operation, releaseReservationAfterFailure);
              retainLifecycleUntil?.(operation);
            },
          );
          const shutdownContext: ShutdownDeadlineContext = {
            device,
            timer: dependencies.timer,
            deadlineMs: shutdownDeadlineMs,
            timeoutMs,
            requestAbortSignal,
            retainReservationUntil: retainShutdownUntil,
          };
          const { killTarget, stopIdentity, androidObserverState } = await preparePlatformShutdown(
            { dependencies, context, options, devicePool, shutdownContext, perf },
            fence.clear,
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
            {
              devicePool,
              options: {
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
        } finally {
          fence.settle();
        }
      },
      failure: (error) => rethrowShutdownFailure(device, requestAbortSignal, error),
    }),
  );
}
