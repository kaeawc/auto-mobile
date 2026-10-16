import { holderOf } from "../daemon/deviceBinding";
import { ActionableError, type BootedDevice, type DeviceInfo } from "../models";
import type { DevicePool, DeviceReadinessReservation, PooledDevice } from "../daemon/devicePool";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import type { Timer } from "../utils/SystemTimer";
import type { DeviceBootResult, DeviceBootService } from "../devices/deviceBootService";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { runOutsideRequestContext, runWithAbortSignal } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import type { ProgressCallback } from "./toolRegistry";
import type {
  StartDeviceArgs,
  ColdBootSettlementCollector,
  cancelUnownedColdBoot,
  isUnknownAndroidRuntimeName,
  runWithinShutdownDeadline,
} from "./deviceTools";
import { getHostEmulatorProcessStopper } from "../devices/hostEmulatorProcessStopper";
import { getShutdownInitiatingExecutionId } from "./deviceToolsShutdown";
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
  assertHolder: () => void;
  collectColdBootSettlement: ColdBootSettlementCollector;
  publishReplacementReadinessMarker?: (replacement: BootedDevice) => void;
  releasePreservedSession: (
    replacement: PooledDevice,
    preservedSessionId: string | undefined,
  ) => Promise<void>;
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
  const { boot, devicePool, signal, recoveryAutolockClient, collectColdBootSettlement } = context;
  context.assertHolder();
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
  const state: SystemUiAnrRestartState = {
    sourceImage,
    releaseReadinessReservation,
    shutdownWasConfirmed: false,
    shutdown: {},
  };
  const runningBeforeCall = wasRunningBeforeCall(boot);
  const restartContext = runningBeforeCall
    ? { ...context, signal: new AbortController().signal }
    : context;
  let backgroundTail = false;
  let keepReadinessReservation = false;
  let restart: Promise<SystemUiAnrRecoveryResult> | undefined;
  try {
    state.shutdownReservation = await reserveSystemUiAnrShutdown(
      devicePool,
      boot.device.deviceId,
      signal,
      recoveryAutolockClient,
      context.assertHolder,
    );
    // Before dispatch the request still owns cancellation: nothing has been touched yet.
    signal?.throwIfAborted();
    restart = runningBeforeCall
      ? runOutsideRequestContext(() =>
          runWithAbortSignal(restartContext.signal, () =>
            restartAndroidForSystemUiAnr(restartContext, state, signal),
          ),
        )
      : restartAndroidForSystemUiAnr(restartContext, state, signal);
    const result = runningBeforeCall
      ? await raceWithDeadline(restart, {
          signal,
          timer: context.timer,
          label: "System UI ANR recovery",
        })
      : await restart;
    keepReadinessReservation = true;
    return result;
  } catch (error) {
    if (shouldFinishCancelledRestart(boot, signal, state) && restart) {
      // The request returns now; the recovery owns all reservations until its bounded tail ends.
      backgroundTail = true;
      const pendingRestart = restart;
      collectColdBootSettlement(
        runOutsideRequestContext(() =>
          settleCancelledSystemUiAnrRecovery(pendingRestart, restartContext, state),
        ),
      );
      throw error;
    }
    await cleanUpRecoveryFailure(context, state);
    throw error;
  } finally {
    if (!backgroundTail) {
      await releaseRecoveryReservations(state, keepReadinessReservation);
    }
  }
}

interface SystemUiAnrRestartState {
  sourceImage: DeviceInfo;
  releaseReadinessReservation: DeviceReadinessReservation | undefined;
  shutdownReservation?: Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>;
  shutdownWasConfirmed: boolean;
  shutdown: SystemUiAnrShutdownState;
  replacementBoot?: DeviceBootResult;
}

function wasRunningBeforeCall(boot: DeviceBootResult): boolean {
  return !boot.provisioned && (boot.source === "booted" || boot.runningBeforeCall === true);
}

function shouldFinishCancelledRestart(
  boot: DeviceBootResult,
  signal: AbortSignal | undefined,
  state: SystemUiAnrRestartState,
): boolean {
  return (
    wasRunningBeforeCall(boot) && signal?.aborted === true && state.shutdown.command !== undefined
  );
}

async function restartAndroidForSystemUiAnr(
  context: SystemUiAnrRebootContext,
  state: SystemUiAnrRestartState,
  requestSignalBeforeKill: AbortSignal | undefined,
): Promise<SystemUiAnrRecoveryResult> {
  const { boot, bootService, args, totalDeadlineMs, signal, progress, devicePool } = context;
  await shutdownAndroidForSystemUiAnr(
    context,
    state.shutdown,
    requestSignalBeforeKill,
    state.sourceImage.name,
  );
  state.shutdownWasConfirmed = true;
  state.replacementBoot = carryCreatedByCall(
    await bootSystemUiAnrReplacement(
      bootService,
      args,
      state.sourceImage,
      totalDeadlineMs,
      signal,
      progress,
    ),
    boot,
  );
  assertSystemUiAnrReplacementIdentity(state.replacementBoot, state.sourceImage);
  // Identity is the AVD name, not the emulator port. A wrong AVD remains call-owned.
  if (wasRunningBeforeCall(boot) && !state.replacementBoot.provisioned) {
    state.replacementBoot.runningBeforeCall = true;
  }
  const adoptedReplacementBoot = state.replacementBoot;
  const handoff = await handoffSystemUiAnrReplacement(
    devicePool,
    state.shutdownReservation,
    adoptedReplacementBoot,
    state.sourceImage,
    context.publishReplacementReadinessMarker,
  );
  return {
    boot: adoptedReplacementBoot,
    preservedSessionId: handoff?.preservedSessionId,
    releaseReadinessReservation: state.releaseReadinessReservation,
    retireReplacement: async () =>
      await retireSystemUiAnrReplacement(
        devicePool,
        handoff?.replacementDevice,
        adoptedReplacementBoot,
        context.collectColdBootSettlement,
        context.operations,
        {
          sessionId: handoff?.preservedSessionId,
          release: async (replacement) =>
            await context.releasePreservedSession(replacement, handoff?.preservedSessionId),
        },
      ),
    validatePreservedSession: handoff?.validatePreservedSession,
    releaseRecoveryRouteLease: state.shutdownReservation?.releaseRecoveryRouteLease,
  };
}

async function settleCancelledSystemUiAnrRecovery(
  restart: Promise<SystemUiAnrRecoveryResult>,
  context: SystemUiAnrRebootContext,
  state: SystemUiAnrRestartState,
): Promise<void> {
  try {
    const recovered = await restart;
    // Never validate or bind for the cancelled request. Release its preserved owner only
    // after the replacement is fully handed off, while the AVD is still fenced.
    await recovered.retireReplacement?.();
  } catch (error) {
    logger.warn(
      `[DeviceTools] Background System UI ANR recovery failed: ${errorMessage(error)}`,
      error,
    );
    await cleanUpRecoveryFailure(context, state, true);
  } finally {
    await releaseRecoveryReservations(state, false);
  }
}

async function cleanUpRecoveryFailure(
  context: SystemUiAnrRebootContext,
  state: SystemUiAnrRestartState,
  waitForTermination = false,
): Promise<void> {
  // A failed handoff already rolled its pool entry back. A confirmed same-AVD replacement
  // stays alive; a mismatched or call-cold-booted replacement remains call-owned.
  const settlement = context.operations.cancelUnownedColdBoot(state.replacementBoot);
  context.collectColdBootSettlement(settlement);
  // The detached tail itself must own a late termination: prepareDevice has already taken
  // its settlement snapshot by then, so merely adding another promise would release the lease early.
  if (waitForTermination) {
    await settlement;
  }
  try {
    await cleanUpFailedSystemUiAnrRecovery(
      context,
      state.shutdownReservation,
      state.shutdownWasConfirmed,
      state.shutdown,
    );
  } catch (error) {
    logger.warn(
      `[DeviceTools] Failed to clean up after System UI ANR recovery failure: ${errorMessage(error)}`,
      error,
    );
  }
}

async function releaseRecoveryReservations(
  state: SystemUiAnrRestartState,
  keepReadinessReservation: boolean,
): Promise<void> {
  try {
    await state.shutdownReservation?.release();
  } catch (error) {
    // Release is best-effort cleanup and must not replace the shutdown outcome.
    logger.warn(
      `[DeviceTools] Failed to release System UI ANR shutdown reservation: ${errorMessage(error)}`,
      error,
    );
  }
  if (keepReadinessReservation) {
    return;
  }
  try {
    await state.releaseReadinessReservation?.();
  } catch (error) {
    logger.warn(
      `[DeviceTools] Failed to release System UI ANR readiness reservation: ${errorMessage(error)}`,
      error,
    );
  } finally {
    state.shutdownReservation?.releaseRecoveryRouteLease();
  }
}

async function reserveSystemUiAnrShutdown(
  devicePool: DevicePool | undefined,
  deviceId: string,
  signal: AbortSignal | undefined,
  autolockClient: { mcpSessionId?: string; expectedSessionId?: string } | undefined,
  assertHolder: () => void,
): Promise<Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>> {
  if (!devicePool) {
    return undefined;
  }
  const reservation = await devicePool.reserveDeviceForShutdown(
    deviceId,
    signal,
    autolockClient,
    assertHolder,
  );
  if (reservation) {
    // Unnamed: rebooting on the session's behalf is not the session giving the device up.
    devicePool.markIntentionalShutdown(deviceId);
  }
  return reservation;
}

async function shutdownAndroidForSystemUiAnr(
  context: SystemUiAnrRebootContext,
  shutdown: SystemUiAnrShutdownState,
  requestSignalBeforeKill: AbortSignal | undefined,
  expectedAvdName: string,
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
        requestSignalBeforeKill?.throwIfAborted();
        shutdown.command = deviceManager.killDevice(device, {
          signal: shutdownSignal,
          timeoutMs,
          ...(device.platform === "android"
            ? {
                processStop: {
                  stopper: getHostEmulatorProcessStopper(timer),
                  expectedAvdName,
                },
              }
            : {}),
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

/**
 * The replacement reboots the same AVD, which the original boot may have created for this very
 * call. The replacement booted an existing image, so its own `provisioned` is false; carry the
 * original's, or a later bind failure could neither delete that AVD nor attribute it to this call
 * (#11548). An AVD that pre-existed stays false: the original is false then too.
 */
function carryCreatedByCall(
  replacement: DeviceBootResult,
  original: DeviceBootResult,
): DeviceBootResult {
  return { ...replacement, provisioned: original.provisioned || replacement.provisioned };
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
): Promise<void> {
  const { devicePool, boot, signal, operations } = context;
  if (!shutdownReservation) {
    return;
  }
  if (shutdownWasConfirmed) {
    await devicePool?.retireDeviceAfterSystemUiAnrRecoveryFailure(shutdownReservation.device);
    return;
  }
  // An unstarted command cannot cause a late exit. After invocation, preserve
  // the original cleanup: caller abort retains the marker, deadline clears it.
  if (
    !shutdown.command ||
    operations.shouldClearIntentionalShutdownAfterFailure("android", signal)
  ) {
    devicePool?.clearIntentionalShutdown(boot.device.deviceId);
    return;
  }
  noteSettledRejectedKillCommand(devicePool, shutdownReservation.device, shutdown.command);
}

/**
 * The retained marker fences a late exit of an accepted kill. A kill command that
 * itself rejected (for example a request abort during its device discovery, before
 * `emu kill` was sent) never stopped the emulator, so once it settles a later fresh
 * observation of the same incarnation may lift the fence, exactly as `killDevice`
 * does for a late command failure. A kill that resolved was accepted, so the
 * emulator is dying and stays fenced until its disconnect.
 */
function noteSettledRejectedKillCommand(
  devicePool: DevicePool | undefined,
  device: PooledDevice,
  command: Promise<BootedDevice | void>,
): void {
  if (!devicePool) {
    return;
  }
  // `.then(undefined, ...)` also observes the rejection; a command that resolved
  // leaves the marker in place, so there is nothing else to do for it.
  void command.then(undefined, () => devicePool.noteLatePlatformShutdownSettled(device));
}

async function retireSystemUiAnrReplacement(
  devicePool: DevicePool | undefined,
  expectedReplacement: PooledDevice | undefined,
  replacementBoot: DeviceBootResult,
  collectColdBootSettlement: ColdBootSettlementCollector,
  operations: SystemUiAnrRecoveryOperations,
  preservedSession: {
    sessionId: string | undefined;
    release: (replacement: PooledDevice) => Promise<void>;
  },
): Promise<void> {
  const currentReplacement = devicePool?.getDevice(replacementBoot.device.deviceId);
  // Exact binds can also arrive after handoff, while replacement readiness is pending.
  if (holderOf(currentReplacement) && holderOf(currentReplacement) !== preservedSession.sessionId) {
    return;
  }
  if (replacementBoot.runningBeforeCall) {
    if (
      expectedReplacement &&
      devicePool?.getDevice(expectedReplacement.id) === expectedReplacement
    ) {
      await preservedSession.release(expectedReplacement);
    }
    collectColdBootSettlement(operations.cancelUnownedColdBoot(replacementBoot));
    return;
  }
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
