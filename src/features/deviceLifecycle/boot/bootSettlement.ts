import { defaultDaemonContext } from "../../../daemon/daemonContext";
import { holderOf } from "../../../daemon/deviceBinding";
import {
  requestAcquisitionReceipt,
  type AcquisitionReceipt,
  commitAcquisition,
} from "../../../daemon/acquisitionReceipt";
import { type DeviceBootResult } from "../../../devices/deviceBootService";
import { logger } from "../../../utils/logger";
import { terminateColdBootProcess } from "../../../devices/coldBootProcessTermination";
import { undoUndeliveredAcquisition } from "../../../daemon/acquisitionUndo";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { defaultTimer } from "../../../utils/SystemTimer";
import { type DeviceResourceConfigurationResult } from "../../../models/DeviceResourceConfiguration";
import { createStructuredToolResponse } from "../../../utils/toolUtils";
import {
  DeviceUnhealthyError,
  DeviceTransportOfflineError,
} from "../../../models/deviceAcquisitionRefusals";
import { RunnerReadinessError } from "../../../ctrlProxy/RunnerReadinessService";
import { DeviceLostError } from "../../../models/DeviceLostError";
import {
  type VirtualDeviceLifecycleIdentity,
  type VirtualDeviceLifecycleLease,
} from "../../../devices/virtualDeviceLifecycleCoordinator";
import { SomePlatform } from "../../../models";
import { getDeviceToolsDependencies, initializedDevicePool } from "../core/dependencies";
import { type DeadlineBoundOperation, DEVICE_SHUTDOWN_TIMEOUT_MS } from "../core/deadlines";

/**
 * The live session holding `deviceId`, unless this request's own acquisition put it there: the
 * session a request minted or moved is taken back by that request's undo, not kept.
 */
export function liveHolderOtherThanThisRequest(deviceId: string): string | undefined {
  const devicePool = defaultDaemonContext.devicePool();
  const sessionManager = defaultDaemonContext.sessionManager();
  if (!devicePool || !sessionManager) {
    return undefined;
  }
  const holder = holderOf(devicePool.getDevice(deviceId));
  if (!holder || !sessionManager.findSession(holder)) {
    return undefined;
  }
  const receipt = requestAcquisitionReceipt();
  const ownSessions = [receipt?.minted?.session.sessionId, receipt?.rebound?.session.sessionId];
  return ownSessions.includes(holder) ? undefined : holder;
}

/** Shared by ordinary cancellation and recovery cleanup, which otherwise differs in holder checks. */
export function leavePreviouslyRunningBoot(boot: DeviceBootResult | undefined): boolean {
  if (!boot || (!boot.runningBeforeCall && boot.source !== "booted")) {
    return false;
  }
  logger.info(
    `[DeviceTools] Leaving ${boot.device.deviceId} running: it was running before this call`,
  );
  return true;
}

/**
 * `cancelUnownedColdBoot` without the other-holder check. System UI ANR recovery uses it for its
 * replacement boot: the replacement reuses the serial of the device it replaces, whose pool entry
 * still names the session being recovered, so that holder says nothing about the replacement.
 */
export function stopUnownedColdBoot(boot: DeviceBootResult | undefined): Promise<void> | undefined {
  if (leavePreviouslyRunningBoot(boot)) {
    return undefined;
  }
  if (boot?.source !== "cold-boot" || !boot.processHandle) {
    return undefined;
  }
  const devicePool = defaultDaemonContext.devicePool();
  if (devicePool?.hasStartedDeviceProcess(boot.device.deviceId, boot.processHandle)) {
    // The pool tracks an Android emulator's process from the bind on. That alone is not
    // ownership: only a session holding the device keeps the emulator this call booted alive,
    // the same rule an iOS simulator's boot handle already follows (#11593).
    if (holderOf(devicePool.getDevice(boot.device.deviceId))) {
      logger.info(
        `[DeviceTools] Cold boot ${boot.device.deviceId} process ownership transferred before cleanup`,
      );
      return undefined;
    }
    // Unnamed: cancelling an unowned cold boot is not the session giving the device up.
    defaultDaemonContext.devicePoolWrites()?.markIntentionalShutdown(boot.device.deviceId);
  }
  const settleFence = defaultDaemonContext
    .devicePoolWrites()
    ?.fenceUnpooledShutdown(boot.device.deviceId);
  const termination = terminateColdBootProcess(
    boot.processHandle,
    boot.device.deviceId,
    getDeviceToolsDependencies().timer,
  );
  return termination.confirmed
    .then((confirmed) => {
      if (!confirmed) {
        logger.warn(
          `[DeviceTools] Unowned cold boot ${boot.device.deviceId} still running after SIGKILL; ` +
            "releasing its deferred resources anyway",
        );
      }
    })
    .finally(() => settleFence?.());
}

export function cancelUnownedColdBoot(
  boot: DeviceBootResult | undefined,
): Promise<void> | undefined {
  if (leavePreviouslyRunningBoot(boot)) {
    return undefined;
  }
  if (boot?.source !== "cold-boot" || !boot.processHandle) {
    return undefined;
  }
  const otherHolder = liveHolderOtherThanThisRequest(boot.device.deviceId);
  if (otherHolder) {
    // A readiness reservation keeps the device out of general allocation only, so another
    // session's exact bind is admitted while this call still prepares the runner (#11651).
    // Lifecycle on a device another session holds is refused: it stays running for its holder,
    // and it stays counted against boot capacity as the booted device it is.
    logger.info(
      `[DeviceTools] Leaving cold boot ${boot.device.deviceId} running: session ${otherHolder} holds it`,
    );
    return undefined;
  }
  return stopUnownedColdBoot(boot);
}

/**
 * A session bind as a deadline-bound operation: when its request is cancelled or times out while
 * the bind finishes, the caller gets no session id, so what the bind minted is released again
 * (#11565). The pool fills the receipt in while it binds. `bootOf` names the boot the bind is
 * for: once its session is gone, the device this request cold-booted is stopped on either
 * platform (#11593). The request still holds the device's lifecycle lease at that point. `bind`
 * receives the deadline-bound operation signal, so it can cancel its own work (#15671).
 */
export function bindUndoneIfUndelivered(
  bind: (receipt: AcquisitionReceipt, signal: AbortSignal) => Promise<string>,
  bootOf?: () => DeviceBootResult | undefined,
): DeadlineBoundOperation<string> {
  return async (signal, undoIfUndelivered, onDelivered) => {
    // One receipt per acquiring request, so the request-level undo sees what this bind minted.
    const requestReceipt = requestAcquisitionReceipt();
    const receipt = requestReceipt ?? {};
    // A request-level receipt waits for the entire handler; a private one commits only when
    // the deadline race actually delivers this bind's result.
    if (!requestReceipt) {
      onDelivered(() => commitAcquisition(receipt));
    }
    undoIfUndelivered(async () => {
      await undoUndeliveredAcquisition(receipt, signal.reason);
      const boot = bootOf?.();
      // A session the undo had to leave in place keeps the device it runs on.
      if (boot && !holderOf(initializedDevicePool()?.getDevice(boot.device.deviceId))) {
        await cancelUnownedColdBoot(boot);
      }
    });
    return await bind(receipt, signal);
  };
}

export async function waitForProvisionDeviceRequest<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return await promise;
  }
  if (signal.aborted) {
    throw signal.reason;
  }

  return await raceWithDeadline(promise, {
    timer: defaultTimer,
    signal,
    label: "Provision device request",
    relabelDefaultAbort: false,
  });
}

/**
 * Distinguish "the caller went away" from a provisioning failure.
 * `waitForProvisionDeviceRequest` rejects with the caller signal's own reason, which
 * is a `DOMException(AbortError)` unless the caller supplied one.
 */
export function isProvisionDeviceCallerAbort(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (signal?.aborted && error === signal.reason) {
    return true;
  }
  return error instanceof DOMException && error.name === "AbortError";
}

export function createProvisionDeviceResponse(result: Record<string, unknown>) {
  const device = result.device as { name: string; platform: string };
  const resources = result.resources as DeviceResourceConfigurationResult | undefined;
  const resourceFailure = resources?.success === false;
  const sessionId = typeof result.sessionId === "string" ? result.sessionId : undefined;
  return {
    ...createStructuredToolResponse({
      message: `${device.platform} '${device.name}' provisioned (${result.lifecycleState})${resourceFailure ? "; requested resource configuration was not fully applied" : ""}`,
      ...result,
      // `sessionId` remains the daemon-internal session handle. Canonical readers use `runtime.session.sessionUuid` or this
      // `sessionId`; the former top-level `sessionUuid` alias was unused.
      ...(sessionId ? { sessionId } : {}),
      ...(resources ? { success: resources.success } : {}),
    }),
    ...(resourceFailure ? { isError: true } : {}),
  };
}

export function coldBootRetryReason(failure: unknown): string | undefined {
  if (
    failure instanceof DeviceUnhealthyError &&
    failure.devices.every((device) => device.recovering && device.reason === "recording-teardown")
  ) {
    return "recording-teardown";
  }
  return failure instanceof DeviceTransportOfflineError
    ? failure.code
    : failure instanceof RunnerReadinessError &&
        failure.deadlineExhausted &&
        !(failure.diagnosticCause instanceof DeviceLostError)
      ? (failure.phase ?? "timeout")
      : undefined;
}

/** Keep a ready, existing emulator available for another acquisition after a transient failure. */
export function cancelUnownedColdBootUnlessRetryable(
  boot: DeviceBootResult | undefined,
  failure: unknown,
  signal: AbortSignal | undefined,
): Promise<void> | undefined {
  const retryReason = coldBootRetryReason(failure);
  if (
    boot?.source === "cold-boot" &&
    boot.device?.platform === "android" &&
    boot.provisioned !== true &&
    !signal?.aborted &&
    retryReason !== undefined
  ) {
    logger.info(
      `[DeviceTools] Leaving cold boot ${boot.device.deviceId} running for a retry: ${retryReason}`,
    );
    return undefined;
  }
  return cancelUnownedColdBoot(boot);
}

/**
 * Stop the device a request booted, and delete the one it created, once that request's result
 * turned out undelivered and its session is gone (#11593). The request's own lifecycle lease is
 * released by then, so this takes the device's lease again and queues behind any start already
 * waiting on it; a device some session holds by the time the lease arrives is left to that session.
 */
export async function rollBackUndeliveredBoot(
  boot: DeviceBootResult,
  identity: VirtualDeviceLifecycleIdentity,
  deleteCreated?: (lifecycleLease: VirtualDeviceLifecycleLease) => Promise<void>,
): Promise<void> {
  if (boot.runningBeforeCall || (boot.source !== "cold-boot" && !deleteCreated)) {
    logger.info(
      `[DeviceTools] Leaving ${boot.device.deviceId} running: it was running before this call`,
    );
    return;
  }
  const deps = getDeviceToolsDependencies();
  const lifecycleLease = await deps.lifecycleCoordinator.reserve(identity, {
    operation: "start",
    deadlineMs: deps.timer.now() + DEVICE_SHUTDOWN_TIMEOUT_MS,
  });
  try {
    const holder = holderOf(initializedDevicePool()?.getDevice(boot.device.deviceId));
    if (holder) {
      logger.info(
        `[DeviceTools] Leaving ${boot.device.deviceId} running: session ${holder} acquired it after the cancelled call released it`,
      );
      return;
    }
    await cancelUnownedColdBoot(boot);
    await deleteCreated?.(lifecycleLease);
  } finally {
    lifecycleLease.release();
  }
}

export function clearColdBootShutdownMarker(
  source: "booted" | "cold-boot",
  deviceId: string,
): void {
  if (source === "cold-boot") {
    defaultDaemonContext.devicePoolWrites()?.clearIntentionalShutdown(deviceId);
  }
}

export function publishWarmDeviceReady(source: "booted" | "cold-boot", deviceId: string): void {
  if (source === "booted") {
    defaultDaemonContext.devicePoolWrites()?.notifyDeviceReady(deviceId);
  }
}

export async function validatePreservedSystemUiAnrRecoverySession(
  preservedSessionId: string | undefined,
  validatePreservedSession: (() => Promise<void>) | undefined,
  retireReplacement: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!preservedSessionId) {
    return;
  }
  try {
    await validatePreservedSession?.();
  } catch (error) {
    try {
      await retireReplacement?.();
    } catch (retireError) {
      logger.warn(
        `[DeviceTools] Failed to retire stale System UI recovery replacement: ${retireError}`,
        retireError,
      );
    }
    throw error;
  }
}

export function shouldClearIntentionalShutdownAfterFailure(
  platform: SomePlatform,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return platform === "android" && !requestAbortSignal?.aborted;
}
