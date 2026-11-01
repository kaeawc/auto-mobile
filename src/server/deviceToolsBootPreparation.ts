import {
  adoptRestartResumeTargets,
  internalMcpSessionId,
  internalOneShotCli,
} from "./internalToolParams";
import { holderOf } from "../daemon/deviceBinding";
import { currentTaskContext } from "./tasks/runAsTask";
import { bindingPoolGate } from "../daemon/sessionBroker/provisioning/poolGate";
import { DeviceInfo } from "../models";
import type { DeviceMatcher } from "../utils/deviceMatcher";
import type { DaemonStateLike } from "../daemon/daemonState";
import { isAnonymousAcquisitionSession } from "../daemon/sessionManager";
import { requestAcquisitionReceipt } from "../daemon/acquisitionReceipt";
import type { DeviceReadinessReservation } from "../daemon/devicePool";
import { type DeviceBootResult } from "../devices/deviceBootService";
import { logger } from "../utils/logger";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { runWithAbortSignal } from "../utils/AbortContext";
import type { Timer } from "../utils/SystemTimer";
import type { VirtualDeviceLifecycleLease } from "../devices/virtualDeviceLifecycleCoordinator";
import { ProgressCallback } from "./toolRegistry";
import { errorMessage } from "../utils/describeUnknownError";
import {
  ProvisionDeviceCleanup,
  StartDeviceArgs,
  cancelUnownedColdBoot,
  getStartDevicePool,
  initializedDevicePool,
  liveHolderOtherThanThisRequest,
  rollBackUndeliveredBoot,
  runOperationWithinDeadline,
  startRequester,
} from "../features/deviceLifecycle/deviceLifecycleCore";

/**
 * Removes a device a createIfMissing acquisition created and then failed to
 * bind or boot, reusing provisionDevice's rollback (#11100). The lease is
 * transferred to the teardown; a deferred cleanup keeps it until it finishes.
 */
export type CreatedDeviceRollback = (
  createdDevice: DeviceInfo,
  failure: unknown,
  options: {
    lifecycleLease: VirtualDeviceLifecycleLease;
    pendingMutationSettlement?: Promise<unknown>;
    collectDeferredCleanup?: (cleanup: Promise<void>) => void;
  },
) => Promise<ProvisionDeviceCleanup>;

/** Bound a request's wait; shared removal cleanup must retain its own lifetime. */
export async function waitForDevicePreparation<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  options: {
    timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
    deadlineMs: number;
    signal?: AbortSignal;
    timeoutError: () => Error;
    cancelOperation?: boolean;
  },
): Promise<T> {
  const { timer, deadlineMs, signal, timeoutError, cancelOperation } = options;
  // Caller cancellation takes precedence even when the deadline is already past.
  signal?.throwIfAborted();
  const remainingMs = Math.floor(deadlineMs - timer.now());
  if (remainingMs <= 0) {
    throw timeoutError();
  }
  if (cancelOperation) {
    return await runOperationWithinDeadline(timer, deadlineMs, signal, { operation, timeoutError });
  }
  return await raceWithDeadline(() => runWithAbortSignal(undefined, () => operation()), {
    timer,
    timeoutMs: remainingMs,
    signal,
    label: "Device preparation",
    timeoutError,
  });
}

export type BootPreparationOptions = {
  autolockEnabled: boolean;
  deviceMatcher: DeviceMatcher;
  bootDeadlineMs: number;
  requestedIdentity: string;
  progress: ProgressCallback | undefined;
  signal: AbortSignal | undefined;
  perf: ReturnType<typeof createPerformanceTracker>;
  releaseReadinessReservations: DeviceReadinessReservation[];
  lifecycleLease: VirtualDeviceLifecycleLease;
  rollbackCreatedDevice?: CreatedDeviceRollback;
  state: {
    boot: DeviceBootResult | undefined;
    ownershipTransferred: boolean;
    // Every unowned cold boot this request cancelled, recovery included. The
    // lifecycle lease is released only once all of them have settled.
    coldBootSettlements: Promise<void>[];
    bindingSettlements: Promise<unknown>[];
  };
};

export function createdDeviceRollbackFor(
  options: BootPreparationOptions,
):
  | ((
      device: DeviceInfo,
      failure: unknown,
      rollbackOptions?: { pendingCreation?: Promise<unknown> },
    ) => Promise<void>)
  | undefined {
  const { rollbackCreatedDevice, lifecycleLease, state } = options;
  if (!rollbackCreatedDevice) {
    return undefined;
  }
  return async (device, failure, rollbackOptions) => {
    // A failed cold boot's emulator may still be terminating, and a cancelled
    // binding may still be draining; the device must not be deleted underneath
    // either, so the rollback waits (bounded) for them first.
    // A cancelled create may also still be running (#11155).
    const pendingTerminations = [
      ...state.coldBootSettlements,
      ...state.bindingSettlements,
      ...(rollbackOptions?.pendingCreation ? [rollbackOptions.pendingCreation] : []),
    ];
    try {
      const cleanup = await rollbackCreatedDevice(device, failure, {
        lifecycleLease,
        pendingMutationSettlement:
          pendingTerminations.length > 0 ? Promise.allSettled(pendingTerminations) : undefined,
        // Keeps the lease held by prepareDevice until the deferred rollback ends.
        collectDeferredCleanup: (cleanup) => state.coldBootSettlements.push(cleanup),
      });
      logCreatedDeviceRollback(device, failure, cleanup);
    } catch (error) {
      // The boot failure is what the caller must see; the rollback failure is logged.
      logger.warn(
        `[DeviceTools] Rollback of created ${device.platform} device '${device.name}' threw: ${errorMessage(error)}`,
        error,
      );
    }
  };
}

/**
 * Leave a daemon-log trace of every createIfMissing rollback (#11205): which
 * device, why it was rolled back, and whether the delete succeeded. A failed
 * cleanup is logged at warn; the user-visible error only carries the boot failure.
 */
function logCreatedDeviceRollback(
  device: DeviceInfo,
  failure: unknown,
  cleanup: ProvisionDeviceCleanup,
): void {
  const deviceId = device.deviceId ?? cleanup.target.stableId;
  const outcome =
    cleanup.status === "failed"
      ? `failed (${cleanup.failure?.code ?? "unknown"}: ${cleanup.failure?.message ?? "unknown cleanup failure"})`
      : `succeeded${cleanup.state ? ` (${cleanup.state})` : ""}`;
  const message =
    `[DeviceTools] createIfMissing rollback of created ${device.platform} device ` +
    `'${device.name}' (id=${deviceId}) after: ${errorMessage(failure)}; outcome: ${outcome}`;
  if (cleanup.status === "failed") {
    logger.warn(message);
  } else {
    logger.info(message);
  }
}

/**
 * Rolls back a device this request created (createIfMissing) once a post-boot
 * step (readiness reservation, runner setup, session bind) fails before session
 * ownership was transferred (#11155). Boot-time failures are rolled back inside
 * DeviceBootService and leave `state.boot` unset, so they never reach here.
 */
export async function rollbackCreatedDeviceAfterBoot(
  options: BootPreparationOptions,
  failure: unknown,
): Promise<void> {
  const { state } = options;
  const boot = state.boot;
  const createdImage = boot?.provisioned ? boot.sourceImage : undefined;
  const rollback = createdDeviceRollbackFor(options);
  if (!boot || !createdImage || state.ownershipTransferred || !rollback) {
    return;
  }
  const otherHolder = liveHolderOtherThanThisRequest(boot.device.deviceId);
  if (otherHolder) {
    // Another session selected the device while this call prepared it: it is that session's
    // device now, and deleting it is as much lifecycle on it as stopping it (#11651).
    logger.info(
      `[DeviceTools] Keeping created ${boot.device.platform} device '${createdImage.name}': session ${otherHolder} holds it`,
    );
    return;
  }
  // Stop the emulator before deleting its AVD. prepareDevice would otherwise
  // cancel it only after this rollback; clearing `state.boot` keeps that
  // cancellation from signalling the same process twice.
  const termination = cancelUnownedColdBoot(boot);
  if (termination) {
    state.coldBootSettlements.push(termination);
  }
  state.boot = undefined;
  // Readiness reservations stay held through the rollback: releasing them first
  // would expose the still-listed, shutting-down emulator to a concurrent
  // acquisition that could adopt it before its AVD is deleted (#11186). The
  // acquisition `finally` releases them once the rollback settles.
  await rollback(createdImage, failure);
}

/**
 * Record the device this acquisition booted or created on its request's receipt. Ownership has
 * passed to the bound session, so the failure rollbacks above no longer apply; a request that
 * turns out undelivered after this point is undone through the receipt instead (#11593).
 */
export function recordStartedDevice(
  boot: DeviceBootResult,
  options: BootPreparationOptions,
  sessionId: string,
): void {
  // As an MCP task the caller sees the session only once the task settles: hold it until then.
  currentTaskContext()?.holdDeviceLease(sessionId);
  const receipt = requestAcquisitionReceipt();
  if (!receipt) {
    return;
  }
  const { lifecycleLease, rollbackCreatedDevice } = options;
  const createdImage = boot.provisioned ? boot.sourceImage : undefined;
  const { identity } = lifecycleLease;
  receipt.started = {
    rollBack: async (reason) =>
      await rollBackUndeliveredBoot(
        boot,
        identity,
        createdImage && rollbackCreatedDevice
          ? async (rollbackLease) => {
              const cleanup = await rollbackCreatedDevice(createdImage, reason, {
                lifecycleLease: rollbackLease,
              });
              logCreatedDeviceRollback(createdImage, reason, cleanup);
            }
          : undefined,
      ),
  };
}

/** Selectors skip recovery targets and broker bindings before discovery can boot them. */
export async function startMatchExclusions(
  args: StartDeviceArgs,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool">,
): Promise<{
  excludeDeviceNames: ReadonlySet<string> | undefined;
  excludeDeviceIds: ReadonlySet<string> | undefined;
}> {
  const platform = args.platform;
  const managed =
    (await bindingPoolGate(initializedDevicePool()).bindingStableIds?.(platform)) ??
    new Set<string>();
  if (platform === "ios") {
    const exclusions = unionSets(undefined, managed);
    return withRestartMatchExclusions(args, {
      excludeDeviceNames: exclusions,
      excludeDeviceIds: exclusions,
    });
  }
  const recoveryTargets = getStartDevicePool(daemonState)?.getRecoveringAndroidTargets();
  return withRestartMatchExclusions(args, {
    excludeDeviceNames: unionSets(recoveryTargets?.names, managed),
    excludeDeviceIds: recoveryTargets?.serials,
  });
}

function withRestartMatchExclusions(
  args: StartDeviceArgs,
  exclusions: {
    excludeDeviceNames: ReadonlySet<string> | undefined;
    excludeDeviceIds: ReadonlySet<string> | undefined;
  },
) {
  const restart = initializedDevicePool()?.restartReservationExclusions?.(
    args.platform,
    startRequester(args),
  );
  if (!restart) {
    return exclusions;
  }
  adoptRestartResumeTargets(args, restart.resumeTargets);
  return {
    excludeDeviceNames: unionSets(exclusions.excludeDeviceNames, restart.names),
    excludeDeviceIds: unionSets(exclusions.excludeDeviceIds, restart.ids),
  };
}

/**
 * Booted devices of the requested platform that a session this caller could not reuse holds
 * (#11648), or that another request is still preparing and will bind (#11651). A selector-based
 * start takes one only when no other booted device satisfies its spec, so an idle match is never
 * passed over for a refusal. The owner test mirrors the pool bind's: an identified connection
 * reuses a session it acquired (or routes to by autolock), an anonymous caller one an anonymous
 * acquisition created.
 */
export function devicesHeldByOtherSessions(
  args: StartDeviceArgs,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool" | "getSessionManager">,
): ReadonlySet<string> | undefined {
  const pool = getStartDevicePool(daemonState);
  if (!pool) {
    return undefined;
  }
  const mcpSessionId = internalOneShotCli(args) ? undefined : internalMcpSessionId(args);
  const sessionManager = daemonState.getSessionManager();
  const callerMayReuse = (deviceId: string, holderSessionId: string): boolean => {
    if (mcpSessionId === undefined) {
      const holder = sessionManager.getSession(holderSessionId);
      return holder !== null && isAnonymousAcquisitionSession(holder);
    }
    return (
      pool.resolveOwnedDeviceSessionForMcpSession(mcpSessionId, deviceId) === holderSessionId ||
      pool.resolveAutolockSessionForMcpSession(mcpSessionId, undefined, undefined, deviceId) ===
        holderSessionId
    );
  };
  // This runs before the request reserves anything itself, so every readiness reservation it
  // sees belongs to another request.
  const held = pool
    .getAllDevices()
    .filter(
      (device) =>
        device.platform === args.platform &&
        (holderOf(device) === null
          ? pool.isReservedForReadiness(device.id)
          : !callerMayReuse(device.id, holderOf(device)!)),
    )
    .map((device) => device.id);
  return held.length > 0 ? new Set(held) : undefined;
}

/** Undefined when both are empty, so an unrestricted boot request stays unrestricted. */
function unionSets(
  first: ReadonlySet<string> | undefined,
  second: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  if (second.size === 0) {
    return first;
  }
  return first ? new Set([...first, ...second]) : second;
}
