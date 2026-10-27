import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { DeviceInfo } from "../../models";
import { logger } from "../../utils/logger";
import { DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import {
  type ExactDeviceProvisioner,
  ProvisionDeviceError,
} from "../../devices/exactDeviceProvisioning";
import type { ProvisionDeviceLifecycleOutcome } from "../../devices/provisionDeviceLifecycle";
import { type VirtualDeviceLifecycleLease } from "../../devices/virtualDeviceLifecycleCoordinator";
import { DeviceTeardownService } from "../../devices/deviceTeardownService";
import { getProvisionedDeviceTransportFence } from "../../utils/provisionedDeviceTransportFence";
import {
  DeviceToolsDependencies,
  ProvisionDeviceArgs,
  ProvisionDeviceCleanup,
  ProvisionDeviceRollbackError,
  RecordProvisionDeviceLifecycle,
  TeardownDeviceArgs,
  TeardownToolResponse,
  attachProvisionDeviceLifecycle,
  isTeardownFailure,
  isDeviceIntactRefusal,
  lifecycleCleanupStatus,
  lifecycleStateForCleanup,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import { provisionDeviceLifecycleReason } from "./provisioningErrors";
import type { ProvisioningContext } from "./provisioningTypes";

type ProvisionCleanupOptions = {
  createdNeverLaunched?: boolean;
  lifecycleLease: VirtualDeviceLifecycleLease | undefined;
  pendingMutationSettlement?: Promise<unknown>;
  /** Absolute rollback deadline already anchored by the caller (e.g. iOS identity discovery). */
  rollbackDeadlineMs?: number;
  recordLifecycle?: RecordProvisionDeviceLifecycle;
  lifecycleDevice?: NonNullable<ProvisionDeviceLifecycleOutcome["device"]>;
  /** Receives a cleanup deferred until a pending mutation settles; it owns the lease until then. */
  collectDeferredCleanup?: (cleanup: Promise<void>) => void;
};

function teardownResponsePayload(
  response: TeardownToolResponse,
): Record<string, unknown> | undefined {
  const text = response.content.find((content) => content.type === "text")?.text;
  if (!text) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(text);
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch (error) {
    logger.warn(`[DeviceTools] Failed to decode internal teardown response: ${error}`, error);
    return undefined;
  }
}

function provisionDeviceCleanupResult(
  cleanupArgs: TeardownDeviceArgs,
  response: TeardownToolResponse,
): ProvisionDeviceCleanup {
  const payload = teardownResponsePayload(response);
  const failure = payload?.failure;
  if (
    isTeardownFailure(response) &&
    typeof failure === "object" &&
    failure !== null &&
    !Array.isArray(failure)
  ) {
    const failureRecord = failure as Record<string, unknown>;
    return {
      status: "failed",
      target: cleanupArgs.target,
      failure: {
        code: typeof failureRecord.code === "string" ? failureRecord.code : "operation_failed",
        phase: typeof failureRecord.phase === "string" ? failureRecord.phase : "verification",
        message:
          typeof failureRecord.message === "string"
            ? failureRecord.message
            : "Device cleanup failed without a diagnostic.",
      },
    };
  }
  if (isTeardownFailure(response)) {
    return {
      status: "failed",
      target: cleanupArgs.target,
      failure: {
        code: "operation_failed",
        phase: "verification",
        message: "Device cleanup failed without a structured diagnostic.",
      },
    };
  }
  return {
    status: "succeeded",
    target: cleanupArgs.target,
    state: typeof payload?.state === "string" ? payload.state : "destroyed",
  };
}

export async function provisionMutationSettledWithinRollbackBudget(
  deps: DeviceToolsDependencies,
  settlement: Promise<unknown>,
  rollbackDeadlineMs: number,
): Promise<boolean> {
  const remainingMs = Math.floor(rollbackDeadlineMs - deps.timer.now());
  if (remainingMs <= 0) {
    return false;
  }
  const deadline = new Error("Provision rollback settlement wait timed out");
  try {
    return await raceWithDeadline(
      settlement.then(
        () => true,
        () => true,
      ),
      {
        timer: deps.timer,
        timeoutMs: remainingMs,
        label: "Provision rollback settlement",
        timeoutError: () => deadline,
      },
    );
  } catch (error) {
    if (error === deadline) {
      return false;
    }
    throw error;
  }
}

function retainProvisionLifecycleUntilMutationSettles(
  lifecycleLease: VirtualDeviceLifecycleLease,
  settlement: Promise<unknown>,
  stableId: string,
): void {
  void settlement
    .finally(() => lifecycleLease.release())
    .catch((error: unknown) => {
      logger.warn(
        `[DeviceTools] Deferred provision mutation for '${stableId}' rejected before lifecycle ownership was released: ${errorMessage(error)}`,
        error,
      );
    });
}

export function retainPendingProvisionMutationLifecycle(
  args: ProvisionDeviceArgs,
  provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined,
  takeLifecycleLease: () => VirtualDeviceLifecycleLease | undefined,
  pendingMutationSettlement: Promise<unknown> | undefined,
): void {
  if (!pendingMutationSettlement) {
    return;
  }
  const lifecycleLease = takeLifecycleLease();
  if (!lifecycleLease) {
    return;
  }
  const stableId =
    provisioned?.device.platform === "ios"
      ? (provisioned.device.deviceId ?? args.device.name)
      : args.device.name;
  retainProvisionLifecycleUntilMutationSettles(lifecycleLease, pendingMutationSettlement, stableId);
}

function continueProvisionCleanupAfterMutationSettles(
  ctx: ProvisioningContext,
  deps: DeviceToolsDependencies,
  createdDevice: DeviceInfo,
  provisionFailure: ProvisionDeviceError,
  {
    lifecycleLease,
    settlement,
    recordLifecycle,
    lifecycleDevice,
    collectDeferredCleanup,
  }: {
    lifecycleLease: VirtualDeviceLifecycleLease;
    settlement: Promise<unknown>;
    recordLifecycle?: RecordProvisionDeviceLifecycle;
    lifecycleDevice?: NonNullable<ProvisionDeviceLifecycleOutcome["device"]>;
    collectDeferredCleanup?: (cleanup: Promise<void>) => void;
  },
): void {
  const finishCleanup = async (): Promise<void> => {
    const final = await cleanupFailedProvisionDevice(ctx, deps, createdDevice, provisionFailure, {
      lifecycleLease: lifecycleLease,
      pendingMutationSettlement: undefined,
      recordLifecycle: recordLifecycle,
      lifecycleDevice: lifecycleDevice,
    });
    if (final.cleanup.status === "failed") {
      logger.warn(
        `[DeviceTools] Deferred provision cleanup for '${createdDevice.name}' failed: ` +
          `${final.cleanup.failure?.message ?? final.message}`,
      );
    }
  };
  const deferredCleanup = settlement.then(finishCleanup, finishCleanup).catch((error: unknown) => {
    logger.warn(
      `[DeviceTools] Deferred provision cleanup for '${createdDevice.name}' rejected: ${errorMessage(error)}`,
      error,
    );
    lifecycleLease.release();
  });
  collectDeferredCleanup?.(deferredCleanup);
}

function provisionCleanupPreconditionFailure(
  provisionFailure: ProvisionDeviceError,
  cleanupArgs: TeardownDeviceArgs,
  code: string,
  message: string,
): ProvisionDeviceRollbackError {
  return new ProvisionDeviceRollbackError(provisionFailure, {
    status: "failed",
    target: cleanupArgs.target,
    failure: { code, phase: "precondition", message },
  });
}

function unresolvedProvisionCleanup(
  createdDevice: DeviceInfo,
  provisionFailure: ProvisionDeviceError,
): ProvisionDeviceRollbackError {
  return new ProvisionDeviceRollbackError(provisionFailure, {
    status: "failed",
    target: {
      platform: createdDevice.platform,
      isVirtual: true,
      stableId: createdDevice.name,
      stableName: createdDevice.name,
    },
    failure: {
      code: "target_identity_unresolved",
      phase: "precondition",
      message: "The newly created device has no stable identity for cleanup.",
    },
  });
}

function provisionCleanupLifecycle(
  rollbackError: ProvisionDeviceRollbackError,
  lifecycleDevice: NonNullable<ProvisionDeviceLifecycleOutcome["device"]>,
  provisionFailure: ProvisionDeviceError,
): ProvisionDeviceLifecycleOutcome {
  return {
    state: lifecycleStateForCleanup(rollbackError.cleanup),
    phase: "cleanup",
    device: lifecycleDevice,
    reason: provisionDeviceLifecycleReason(provisionFailure),
    cleanup: {
      status: lifecycleCleanupStatus(rollbackError.cleanup),
      reason: provisionFailure.code === "timeout" ? "readiness_timeout" : "provisioning_failure",
    },
  };
}

function rollbackErrorForCleanup(
  provisionFailure: ProvisionDeviceError,
  cleanup: ProvisionDeviceCleanup,
  lifecycleDevice: ProvisionDeviceLifecycleOutcome["device"],
): ProvisionDeviceRollbackError {
  return new ProvisionDeviceRollbackError(
    provisionFailure,
    cleanup,
    isDeviceIntactRefusal(cleanup) && lifecycleDevice ? { retainedDevice: lifecycleDevice } : {},
  );
}

export async function cleanupFailedProvisionDevice(
  ctx: ProvisioningContext,
  deps: DeviceToolsDependencies,
  createdDevice: DeviceInfo,
  provisionFailure: ProvisionDeviceError,
  {
    lifecycleLease,
    pendingMutationSettlement,
    recordLifecycle,
    lifecycleDevice,
    createdNeverLaunched,
    rollbackDeadlineMs = deps.timer.now() + DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
    collectDeferredCleanup,
  }: ProvisionCleanupOptions,
): Promise<ProvisionDeviceRollbackError> {
  const stableId =
    createdDevice.platform === "android" ? createdDevice.name : createdDevice.deviceId;
  if (!stableId) {
    return unresolvedProvisionCleanup(createdDevice, provisionFailure);
  }
  const cleanupArgs: TeardownDeviceArgs = {
    target: {
      platform: createdDevice.platform,
      isVirtual: true,
      stableId,
      stableName: createdDevice.name,
    },
    mode: "destroy",
    verifyAbsence: true,
    timeoutMs: DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  };
  const finalizeCleanup = async (
    rollbackError: ProvisionDeviceRollbackError,
  ): Promise<ProvisionDeviceRollbackError> => {
    if (!recordLifecycle || !lifecycleDevice) {
      return rollbackError;
    }
    const lifecycle = provisionCleanupLifecycle(rollbackError, lifecycleDevice, provisionFailure);
    recordLifecycle(lifecycle);
    if (
      lifecycle.state === "removed" &&
      lifecycleDevice.platform === "android" &&
      lifecycleDevice.runtimeDeviceId
    ) {
      await getProvisionedDeviceTransportFence().retire({
        deviceId: lifecycleDevice.runtimeDeviceId,
        stableId: lifecycleDevice.stableId,
        reason: lifecycle.reason?.code ?? "provisioning failure",
      });
    }
    return attachProvisionDeviceLifecycle(rollbackError, lifecycle);
  };
  const cleanupService = new DeviceTeardownService({
    lifecycleCoordinator: deps.lifecycleCoordinator,
    timer: deps.timer,
  });
  let lifecycleLeaseTransferred = false;
  try {
    if (!lifecycleLease) {
      return await finalizeCleanup(
        provisionCleanupPreconditionFailure(
          provisionFailure,
          cleanupArgs,
          "lifecycle_reservation_lost",
          "The provisioning lifecycle reservation was lost before cleanup.",
        ),
      );
    }
    if (
      pendingMutationSettlement &&
      !(await provisionMutationSettledWithinRollbackBudget(
        deps,
        pendingMutationSettlement,
        rollbackDeadlineMs,
      ))
    ) {
      lifecycleLeaseTransferred = true;
      const pendingCleanup = await finalizeCleanup(
        provisionCleanupPreconditionFailure(
          provisionFailure,
          cleanupArgs,
          "mutation_settlement_timeout",
          "Cancelled provisioning mutation did not settle within the rollback budget; " +
            "cleanup was not attempted and lifecycle ownership remains until it settles.",
        ),
      );
      continueProvisionCleanupAfterMutationSettles(ctx, deps, createdDevice, provisionFailure, {
        lifecycleLease: lifecycleLease,
        settlement: pendingMutationSettlement,
        recordLifecycle: recordLifecycle,
        lifecycleDevice: lifecycleDevice,
        collectDeferredCleanup: collectDeferredCleanup,
      });
      return pendingCleanup;
    }
    const remainingRollbackMs = Math.floor(rollbackDeadlineMs - deps.timer.now());
    if (remainingRollbackMs <= 0) {
      return await finalizeCleanup(
        provisionCleanupPreconditionFailure(
          provisionFailure,
          cleanupArgs,
          "rollback_budget_exhausted",
          "The rollback budget was exhausted before device cleanup could start.",
        ),
      );
    }
    cleanupArgs.timeoutMs = remainingRollbackMs;
    lifecycleLease.transitionToTeardown();
    await lifecycleLease.bindCanonicalIdentity({
      platform: createdDevice.platform,
      stableId,
    });
    const cleanup = ctx.executeDeleteDevice(
      cleanupArgs,
      deps,
      undefined,
      cleanupService,
      lifecycleLease,
      undefined,
      createdNeverLaunched ? { unlaunchedCreatedAvd: { stableId } } : undefined,
    );
    lifecycleLeaseTransferred = true;
    const response = await cleanup;
    const cleanupResult = provisionDeviceCleanupResult(cleanupArgs, response);
    return await finalizeCleanup(
      rollbackErrorForCleanup(provisionFailure, cleanupResult, lifecycleDevice),
    );
  } catch (error) {
    // A rollback failure summarizes to a one-line message in the response, so
    // the daemon log is the only forensic record of what actually went wrong.
    logger.warn(
      `[DeviceTools] provisionDevice rollback teardown failed for '${cleanupArgs.target.stableId}': ${errorMessage(error)}`,
      error,
    );
    return await finalizeCleanup(
      new ProvisionDeviceRollbackError(provisionFailure, {
        status: "failed",
        target: cleanupArgs.target,
        failure: {
          code: "lifecycle_reservation_lost",
          phase: "precondition",
          message: errorMessage(error),
        },
      }),
    );
  } finally {
    if (!lifecycleLeaseTransferred) {
      lifecycleLease?.release();
    }
  }
}
