import { ActionableError, type BootedDevice, type DeviceInfo } from "../models";
import type { DevicePool, DeviceReadinessReservation, PooledDevice } from "../daemon/devicePool";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import type { Timer } from "../utils/SystemTimer";
import type { DeviceBootResult, DeviceBootService } from "../devices/deviceBootService";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import type { ProgressCallback } from "./toolRegistry";
import type {
  StartDeviceArgs,
  ColdBootSettlementCollector,
  cancelUnownedColdBoot,
  isUnknownAndroidRuntimeName,
  runWithinShutdownDeadline,
} from "./deviceTools";
import {
  getShutdownInitiatingExecutionId,
  retainLatePlatformShutdown,
  shouldKeepIntentionalShutdownAfterCommandError,
} from "./deviceToolsShutdown";
import type {
  shouldClearIntentionalShutdownAfterFailure,
  waitForDeviceShutdown,
} from "./deviceToolsShutdown";

interface SystemUiAnrRecoveryOperations {
  deviceShutdownTimeoutMs: number;
  runWithinShutdownDeadline: typeof runWithinShutdownDeadline;
  waitForDeviceShutdown: typeof waitForDeviceShutdown;
  shouldClearIntentionalShutdownAfterFailure: typeof shouldClearIntentionalShutdownAfterFailure;
  cancelUnownedColdBoot: typeof cancelUnownedColdBoot;
  isUnknownAndroidRuntimeName: typeof isUnknownAndroidRuntimeName;
}

async function resolveSystemUiRecoveryImage({
  boot,
  deviceManager,
  devicePool,
  timer,
  totalDeadlineMs,
  signal,
  operations,
}: SystemUiAnrRebootContext): Promise<DeviceInfo> {
  const pooled = devicePool?.getDevice(boot.device.deviceId);
  const avdName =
    pooled?.avdName ??
    (boot.sourceImage?.platform === "android" ? boot.sourceImage.name : undefined) ??
    (operations.isUnknownAndroidRuntimeName(boot.device) ? undefined : boot.device.name);
  if (!avdName) {
    throw new ActionableError(
      `Cannot restart Android device '${boot.device.deviceId}' after a System UI ANR because its AVD name is unknown.`,
    );
  }
  const images = await operations.runWithinShutdownDeadline(
    boot.device,
    timer,
    totalDeadlineMs,
    "System UI recovery image lookup did not complete",
    {
      requestAbortSignal: signal,
      operation: async () => await deviceManager.listDeviceImages("android"),
      timeoutMs: undefined,
      phase: "to resolve its AVD image for System UI ANR recovery",
    },
  );
  const image = images.find(
    (candidate) => candidate.platform === "android" && candidate.name === avdName,
  );
  if (!image) {
    throw new ActionableError(
      `Cannot restart Android device '${boot.device.deviceId}' after a System UI ANR because AVD '${avdName}' is unavailable.`,
    );
  }
  return { ...image, isRunning: false };
}

interface SystemUiAnrShutdownState {
  command?: Promise<BootedDevice | void>;
  settled: boolean;
  retainsReservation: boolean;
}

interface SystemUiAnrRebootContext {
  boot: DeviceBootResult;
  args: StartDeviceArgs;
  bootService: DeviceBootService;
  deviceManager: PlatformDeviceManager;
  devicePool: DevicePool | undefined;
  totalDeadlineMs: number;
  timer: Timer;
  signal: AbortSignal | undefined;
  progress: { report: ProgressCallback } | undefined;
  recoveryAutolockClient: { mcpSessionId?: string; expectedSessionId?: string } | undefined;
  collectColdBootSettlement: ColdBootSettlementCollector;
  publishReplacementReadinessMarker?: (replacement: BootedDevice) => void;
  operations: SystemUiAnrRecoveryOperations;
}

export async function rebootAndroidAfterSystemUiAnr(context: SystemUiAnrRebootContext): Promise<{
  boot: DeviceBootResult;
  preservedSessionId?: string;
  releaseReadinessReservation?: DeviceReadinessReservation;
  retireReplacement?: () => Promise<void>;
  validatePreservedSession?: () => Promise<void>;
  releaseRecoveryRouteLease?: () => void;
}> {
  const {
    boot,
    args,
    bootService,
    devicePool,
    totalDeadlineMs,
    signal,
    progress,
    recoveryAutolockClient,
    collectColdBootSettlement,
    publishReplacementReadinessMarker,
    operations,
  } = context;
  const sourceImage = await resolveSystemUiRecoveryImage(context);
  const releaseReadinessReservation = devicePool
    ? await devicePool.reserveDeviceForReadiness(
        boot.device.deviceId,
        boot.device,
        sourceImage.name,
        sourceImage.name,
        recoveryAutolockClient,
      )
    : undefined;
  let shutdownReservation: Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>;
  let shutdownWasConfirmed = false;
  const shutdown: SystemUiAnrShutdownState = { settled: false, retainsReservation: false };
  let keepReadinessReservation = false;
  let replacementBoot: DeviceBootResult | undefined;
  const releaseShutdownReservation = async (): Promise<void> => {
    try {
      await shutdownReservation?.release();
    } catch (error) {
      // Release is best-effort cleanup and must not replace the shutdown outcome.
      logger.warn(
        `[DeviceTools] Failed to release System UI ANR shutdown reservation: ${errorMessage(error)}`,
        error,
      );
    }
  };
  try {
    shutdownReservation = await reserveSystemUiAnrShutdown(
      devicePool,
      boot.device.deviceId,
      signal,
      recoveryAutolockClient,
    );
    await shutdownAndroidForSystemUiAnr(context, shutdown);
    shutdownWasConfirmed = true;

    replacementBoot = await bootSystemUiAnrReplacement(
      bootService,
      args,
      sourceImage,
      totalDeadlineMs,
      signal,
      progress,
    );
    const adoptedReplacementBoot = replacementBoot;
    assertSystemUiAnrReplacementIdentity(adoptedReplacementBoot, sourceImage);
    const handoff = await handoffSystemUiAnrReplacement(
      devicePool,
      shutdownReservation,
      adoptedReplacementBoot,
      sourceImage,
      publishReplacementReadinessMarker,
    );
    keepReadinessReservation = true;
    return {
      boot: adoptedReplacementBoot,
      preservedSessionId: handoff?.preservedSessionId,
      releaseReadinessReservation,
      retireReplacement: async () =>
        await retireSystemUiAnrReplacement(
          devicePool,
          handoff?.replacementDevice,
          adoptedReplacementBoot,
          collectColdBootSettlement,
          operations,
        ),
      validatePreservedSession: handoff?.validatePreservedSession,
      releaseRecoveryRouteLease: shutdownReservation?.releaseRecoveryRouteLease,
    };
  } catch (error) {
    // The pool rolls an adopted replacement back before rejecting its handoff,
    // so any replacement still in scope here is safe to cancel as an unowned
    // cold boot.
    collectColdBootSettlement(operations.cancelUnownedColdBoot(replacementBoot));
    try {
      await cleanUpFailedSystemUiAnrRecovery(
        context,
        shutdownReservation,
        shutdownWasConfirmed,
        shutdown,
        error,
        releaseShutdownReservation,
      );
    } catch (cleanupError) {
      logger.warn(
        `[DeviceTools] Failed to clean up after System UI ANR recovery failure: ${cleanupError}`,
        cleanupError,
      );
    }
    throw error;
  } finally {
    if (!shutdown.retainsReservation) {
      await releaseShutdownReservation();
    }
    if (!keepReadinessReservation) {
      shutdownReservation?.releaseRecoveryRouteLease();
      try {
        await releaseReadinessReservation?.();
      } catch (error) {
        // Release is best-effort cleanup and must not replace the recovery outcome.
        logger.warn(
          `[DeviceTools] Failed to release System UI ANR readiness reservation: ${errorMessage(error)}`,
          error,
        );
      }
    }
  }
}

async function reserveSystemUiAnrShutdown(
  devicePool: DevicePool | undefined,
  deviceId: string,
  signal: AbortSignal | undefined,
  autolockClient: { mcpSessionId?: string; expectedSessionId?: string } | undefined,
): Promise<Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>> {
  if (!devicePool) {
    return undefined;
  }
  const reservation = await devicePool.reserveDeviceForShutdown(deviceId, signal, autolockClient);
  if (reservation) {
    devicePool.markIntentionalShutdown(deviceId);
  }
  return reservation;
}

async function shutdownAndroidForSystemUiAnr(
  context: SystemUiAnrRebootContext,
  shutdown: SystemUiAnrShutdownState,
): Promise<void> {
  const {
    boot: { device },
    deviceManager,
    timer,
    totalDeadlineMs,
    signal,
    operations,
  } = context;
  const shutdownDevice = await operations.runWithinShutdownDeadline(
    device,
    timer,
    totalDeadlineMs,
    "System UI recovery shutdown command did not complete",
    {
      requestAbortSignal: signal,
      operation: async (shutdownSignal, timeoutMs) => {
        shutdownSignal.throwIfAborted();
        shutdown.command = deviceManager
          .killDevice(device, { signal: shutdownSignal, timeoutMs })
          .finally(() => {
            shutdown.settled = true;
          });
        return await shutdown.command;
      },
      timeoutMs: undefined,
      phase: "to accept its System UI ANR recovery shutdown command",
    },
  );
  await operations.waitForDeviceShutdown({
    deviceManager,
    device: shutdownDevice ?? device,
    timer,
    deadlineMs: totalDeadlineMs,
    requestAbortSignal: signal,
    timeoutMs: operations.deviceShutdownTimeoutMs,
  });
}

async function bootSystemUiAnrReplacement(
  bootService: DeviceBootService,
  args: StartDeviceArgs,
  sourceImage: DeviceInfo,
  totalDeadlineMs: number,
  signal: AbortSignal | undefined,
  progress: { report: ProgressCallback } | undefined,
): Promise<DeviceBootResult> {
  const replacement = await bootService.boot(
    {
      ...args,
      deviceId: undefined,
      name: sourceImage.name,
      // Recovery already resolved this exact AVD image by name, so the boot must
      // reuse that resolution. Without `matchExactName` the request falls back to
      // `DeviceMatcher.matchDeviceImage`, whose name test is a case-insensitive
      // *substring* match under the LATEST strategy: a System UI ANR on `Pixel_7`
      // would kill `Pixel_7` and cold-boot `Pixel_7_API_35` instead.
      matchExactName: true,
      preferRunning: false,
      totalDeadlineMs,
      signal,
    },
    progress,
  );
  return { ...replacement, sourceImage };
}

function assertSystemUiAnrReplacementIdentity(
  replacementBoot: DeviceBootResult,
  sourceImage: DeviceInfo,
): void {
  if (replacementBoot.device.name === sourceImage.name) {
    return;
  }
  // The pool enforces the same rule in `assertSystemUiAnrReplacement`, but only
  // once the handoff is attempted. Failing here keeps a mismatched runtime out of
  // the pool and lets the caller's catch cancel it as an unowned cold boot.
  throw new ActionableError(
    `System UI recovery must replace Android AVD '${sourceImage.name}' with the same runtime, ` +
      `but booted '${replacementBoot.device.name}' (${replacementBoot.device.deviceId}).`,
  );
}

async function handoffSystemUiAnrReplacement(
  devicePool: DevicePool | undefined,
  shutdownReservation: Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>,
  replacementBoot: DeviceBootResult,
  sourceImage: DeviceInfo,
  publishReplacementReadinessMarker?: (replacement: BootedDevice) => void,
): Promise<Awaited<ReturnType<DevicePool["replaceDeviceForSystemUiAnrRecovery"]>> | undefined> {
  if (!devicePool || !shutdownReservation) {
    return undefined;
  }
  return await devicePool.replaceDeviceForSystemUiAnrRecovery(
    shutdownReservation.device,
    replacementBoot.device,
    sourceImage,
    replacementBoot.processHandle,
    () => publishReplacementReadinessMarker?.(replacementBoot.device),
    getShutdownInitiatingExecutionId(),
  );
}

async function cleanUpFailedSystemUiAnrRecovery(
  context: SystemUiAnrRebootContext,
  shutdownReservation: Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>,
  shutdownWasConfirmed: boolean,
  shutdown: SystemUiAnrShutdownState,
  error: unknown,
  releaseShutdownReservation: () => Promise<void>,
): Promise<void> {
  const { devicePool, boot, signal, operations, collectColdBootSettlement } = context;
  if (!shutdownReservation) {
    return;
  }
  if (shutdownWasConfirmed) {
    await devicePool?.retireDeviceAfterSystemUiAnrRecoveryFailure(shutdownReservation.device);
    return;
  }
  const keepIntentionalShutdown = shouldKeepIntentionalShutdownAfterCommandError(error, signal);
  // An unstarted command cannot cause a late exit. Otherwise ambiguous failures
  // keep the marker until command settlement and a later fresh observation.
  if (
    !shutdown.command ||
    (operations.shouldClearIntentionalShutdownAfterFailure("android", signal) &&
      !keepIntentionalShutdown)
  ) {
    devicePool?.clearIntentionalShutdown(boot.device.deviceId);
  }
  if (keepIntentionalShutdown) {
    retainLatePlatformShutdown(
      shutdown.command,
      shutdown.settled,
      (settlement) => {
        shutdown.retainsReservation = true;
        collectColdBootSettlement(settlement);
        void settlement.then(releaseShutdownReservation, releaseShutdownReservation);
      },
      async () => {
        devicePool?.noteLatePlatformShutdownSettled(shutdownReservation.device);
      },
    );
  }
}

async function retireSystemUiAnrReplacement(
  devicePool: DevicePool | undefined,
  expectedReplacement: PooledDevice | undefined,
  replacementBoot: DeviceBootResult,
  collectColdBootSettlement: ColdBootSettlementCollector,
  operations: SystemUiAnrRecoveryOperations,
): Promise<void> {
  try {
    if (expectedReplacement) {
      await devicePool?.retireDeviceAfterSystemUiAnrRecoveryFailure(expectedReplacement);
    }
  } finally {
    // Retiring the pool entry drops its process tracking, allowing the existing
    // cold-boot cleanup to terminate this recovered emulator deterministically.
    // The settlement is handed back so the AVD's lifecycle lease is released only
    // once this emulator has actually exited, exactly as the cold-boot path does.
    collectColdBootSettlement(operations.cancelUnownedColdBoot(replacementBoot));
  }
}

export type SystemUiAnrRecoveryResult = Awaited<ReturnType<typeof rebootAndroidAfterSystemUiAnr>>;
