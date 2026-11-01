import { type SessionManager, type Session } from "../../../daemon/sessionManager";
import { BootedDevice } from "../../../models";
import { type PooledDevice, type DevicePool } from "../../../daemon/devicePool";
import { PlatformDeviceManager } from "../../../devices/deviceUtils";
import { type Timer } from "../../../utils/SystemTimer";
import { type DaemonContext, defaultDaemonContext } from "../../../daemon/daemonContext";
import { logger } from "../../../utils/logger";
import { executionTracker } from "../../../daemon/executionTracker";
import { deviceLossCancellationReason } from "../../../daemon/emulatorLossIncident";
import { errorMessage } from "../../../utils/describeUnknownError";
import { createPerformanceTracker } from "../../../utils/PerformanceTracker";
import {
  findReplacementAfterSessionRelease,
  DEVICE_SHUTDOWN_DISCOVERY_RECHECK_BACKOFF,
  DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS,
  shutdownRecheckDeadlineMs,
} from "./shutdownDiscovery";
import { DEVICE_SHUTDOWN_TIMEOUT_MS, runWithinShutdownDeadline } from "../core/deadlines";
import {
  DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
  getShutdownInitiatingExecutionId,
  isShutdownTimeoutError,
  rebuildSameIdReplacement,
  stopVideoRecordingsBeforeShutdown,
} from "./shutdownPreparation";
import { type TeardownContext } from "./teardownContracts";

export interface ShutdownOwnershipContext {
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

export interface ShutdownRetirementOptions {
  retryAfterDiscoveryFailure?: boolean;
  strictDeadline?: boolean;
  timeoutMs?: number;
  terminalReleaseRetriesRemaining?: number;
  skipAndroidNameEnrichment?: boolean;
}

/** The slice of {@link DaemonContext} the shutdown ownership retirement reads. */
export type ShutdownDaemonView = Pick<
  DaemonContext,
  "isInitialized" | "requireFullDevicePool" | "requireSessionManager"
>;

export function captureCurrentShutdownPooledOwnership(
  device: BootedDevice,
  expectedPooledDevice: PooledDevice | null,
):
  | { daemon: ShutdownDaemonView; devicePool: DevicePool; expectedPooledDevice: PooledDevice }
  | undefined {
  if (!expectedPooledDevice) {
    return undefined;
  }
  const daemon: ShutdownDaemonView = defaultDaemonContext;
  if (!daemon.isInitialized()) {
    return undefined;
  }
  const devicePool = daemon.requireFullDevicePool();
  // A fast reboot can reuse a serial. Do not release or remove a later pool
  // incarnation that happens to use the same device ID.
  if (devicePool.getDevice(device.deviceId) !== expectedPooledDevice) {
    return undefined;
  }
  return { daemon, devicePool, expectedPooledDevice };
}

export async function findReplacementOrRetainShutdownReservation(
  context: ShutdownOwnershipContext,
  observedReplacement: BootedDevice | undefined,
  options: {
    retryAfterFailure: boolean;
    disappearanceConfirmed: boolean;
    strictDeadline: boolean;
    timeoutMs: number;
    skipAndroidNameEnrichment: boolean;
  },
): Promise<BootedDevice | undefined> {
  const {
    retryAfterFailure,
    disappearanceConfirmed,
    strictDeadline,
    timeoutMs,
    skipAndroidNameEnrichment,
  } = options;
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

export type ShutdownSessionOwnershipContext = ShutdownOwnershipContext & {
  sessionManager: SessionManager;
  sessionId: string;
};

export function finishLateShutdownRetirement(
  context: ShutdownOwnershipContext,
  release: Promise<string | null>,
  observedReplacement: BootedDevice | undefined,
  {
    terminalReleaseRetriesRemaining,
    skipAndroidNameEnrichment,
    disappearanceConfirmed,
  }: {
    terminalReleaseRetriesRemaining: number;
    skipAndroidNameEnrichment: boolean;
    disappearanceConfirmed: boolean;
  },
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

export function preserveLateShutdownRetirement(
  context: ShutdownSessionOwnershipContext,
  error: unknown,
  release: Promise<string | null>,
  {
    observedReplacement,
    ...options
  }: {
    terminalReleaseRetriesRemaining: number;
    skipAndroidNameEnrichment: boolean;
    disappearanceConfirmed: boolean;
    observedReplacement?: BootedDevice;
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
  finishLateShutdownRetirement(context, release, observedReplacement, {
    terminalReleaseRetriesRemaining,
    skipAndroidNameEnrichment,
    disappearanceConfirmed,
  });
}

export async function releaseShutdownSessionOwnership(
  context: ShutdownOwnershipContext,
  daemon: Pick<ShutdownDaemonView, "requireSessionManager">,
  observedReplacement: BootedDevice | undefined,
  {
    strictDeadline,
    ...options
  }: {
    timeoutMs: number;
    terminalReleaseRetriesRemaining: number;
    disappearanceConfirmed: boolean;
    skipAndroidNameEnrichment: boolean;
    strictDeadline: boolean;
  },
): Promise<void> {
  const { device, expectedSession, timer, deadlineMs, requestAbortSignal } = context;
  const {
    timeoutMs,
    terminalReleaseRetriesRemaining,
    disappearanceConfirmed,
    skipAndroidNameEnrichment,
  } = options;
  const sessionManager = daemon.requireSessionManager();
  const sessionId = expectedSession?.sessionId;
  if (!sessionId || expectedSession.assignedDevice !== device.deviceId) {
    return;
  }

  await executionTracker.cancelSessionUuidExecutions(
    sessionId,
    deviceLossCancellationReason(device.deviceId),
    { excludeExecutionId: getShutdownInitiatingExecutionId() },
  );
  const release = sessionManager.releaseSession(sessionId, "device-killed", {
    expectedOwner: { session: expectedSession, deviceId: device.deviceId },
  });
  try {
    await runWithinShutdownDeadline(
      device,
      timer,
      shutdownRecheckDeadlineMs(timer, deadlineMs, strictDeadline),
      {
        detail: "session ownership retirement did not complete",
        requestAbortSignal: requestAbortSignal,
        operation: async () => await release,
        timeoutMs: timeoutMs,
      },
    );
  } catch (error) {
    preserveLateShutdownRetirement({ ...context, sessionManager, sessionId }, error, release, {
      observedReplacement,
      terminalReleaseRetriesRemaining,
      skipAndroidNameEnrichment,
      disappearanceConfirmed,
    });
    throw error;
  }
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
  const { daemon, devicePool, expectedPooledDevice: capturedPooledDevice } = ownership;

  await releaseShutdownSessionOwnership(
    { ...context, expectedPooledDevice: capturedPooledDevice },
    daemon,
    observedReplacement,
    {
      strictDeadline,
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
    {
      retryAfterFailure: retryAfterDiscoveryFailure,
      disappearanceConfirmed,
      strictDeadline,
      timeoutMs,
      skipAndroidNameEnrichment,
    },
  );
  if (replacement) {
    await rebuildSameIdReplacement(device, capturedPooledDevice, replacement, {
      devicePool,
      stopPerformanceMonitoring,
    });
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

export async function retireTeardownPooledOwnership(
  context: TeardownContext,
  expectedPooledDevice: PooledDevice,
  name: string,
): Promise<void> {
  const devicePool = defaultDaemonContext.requireDevicePoolWrites();
  const reservation = await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    {
      detail: "stopped-device ownership reservation did not complete",
      requestAbortSignal: context.requestAbortSignal,
      operation: async (signal) =>
        await devicePool.reserveDeviceForShutdown(expectedPooledDevice.id, signal),
      timeoutMs: context.timeoutMs,
    },
  );
  const releaseReservation = async (): Promise<void> => {
    try {
      await reservation?.release();
    } catch (error) {
      // Release is best-effort cleanup and must not replace the shutdown outcome.
      logger.warn(
        `[DeviceTools] Failed to release teardown shutdown reservation for ${expectedPooledDevice.id}: ${errorMessage(error)}`,
        error,
      );
    }
  };
  if (!reservation || reservation.device !== expectedPooledDevice) {
    await releaseReservation();
    return;
  }

  let retainsReservation = false;
  const retainReservationUntil = (retirement: Promise<unknown>): void => {
    retainsReservation = true;
    void retirement.then(releaseReservation, (error) => {
      // A failed retirement has not proved disappearance. Keep this exact
      // pooled incarnation unavailable until a later explicit recovery.
      logger.warn(
        `[DeviceTools] Retaining teardown shutdown reservation for ${expectedPooledDevice.id}: ${error}`,
      );
    });
  };
  const retirementDevice: BootedDevice = {
    platform: expectedPooledDevice.platform,
    name,
    deviceId: expectedPooledDevice.id,
  };
  try {
    await stopVideoRecordingsBeforeShutdown(
      {
        device: retirementDevice,
        timer: context.dependencies.timer,
        deadlineMs: context.deadlineMs,
        timeoutMs: context.timeoutMs,
        requestAbortSignal: context.requestAbortSignal,
        retainReservationUntil,
      },
      createPerformanceTracker(true),
    );
    await retireShutdownOwnership(
      {
        device: retirementDevice,
        expectedPooledDevice,
        expectedSession: reservation.session,
        deviceManager: context.deviceManager,
        timer: context.dependencies.timer,
        deadlineMs: context.deadlineMs,
        requestAbortSignal: context.requestAbortSignal,
        stopPerformanceMonitoring: context.dependencies.stopPerformanceMonitoring,
        retainReservationUntil,
      },
      undefined,
      false,
      {
        retryAfterDiscoveryFailure: false,
        strictDeadline: true,
        timeoutMs: context.timeoutMs,
        terminalReleaseRetriesRemaining: DEVICE_SHUTDOWN_TERMINAL_RELEASE_RETRIES,
        skipAndroidNameEnrichment: context.args.force ?? false,
      },
    );
  } finally {
    if (!retainsReservation) {
      await releaseReservation();
    }
  }
}
