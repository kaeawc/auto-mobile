import { PlatformDeviceManager } from "../../devices/deviceUtils";
import { BootedDevice, DeviceInfo } from "../../models";
import { logger } from "../../utils/logger";
import { McpSessionRecoveryInProgressError } from "../../daemon/devicePool";
import { DaemonHandoffInterruptionError } from "../../daemon/daemonHandoffInterruption";
import { DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import {
  type ExactDeviceProvisioner,
  ProvisionDeviceCreateRejectedError,
} from "../../devices/exactDeviceProvisioning";
import { type VirtualDeviceLifecycleLease } from "../../devices/virtualDeviceLifecycleCoordinator";
import {
  attachProvisionDeviceLifecycle,
  DeviceToolsDependencies,
  ProvisionDeviceArgs,
  RecordProvisionDeviceLifecycle,
  getDeviceToolsDependencies,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import {
  cleanupFailedProvisionDevice,
  retainPendingProvisionMutationLifecycle,
} from "./provisioningCleanup";
import {
  resolveProvisionDeviceRollbackTarget,
  throwProvisionWithUnresolvedCreatedDevice,
  throwProvisionWithoutCreatedDevice,
} from "./provisioningRollbackTarget";
import { provisionDeviceLifecycleReason, toProvisionDeviceError } from "./provisioningErrors";
import { provisionDeviceLifecycleIdentity } from "./provisioningReservation";
import { type ProvisionBootOptions, type ProvisioningContext } from "./provisioningTypes";

export async function rethrowFailedProvisionDeviceLifecycle(
  ctx: ProvisioningContext,
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  deviceManager: PlatformDeviceManager,
  provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined,
  {
    createdAvdNeverLaunched,
    creationStarted,
    retainCreatedForRetry,
    signal,
    takeLifecycleLease,
    error,
    unownedColdBootSettlement,
    pendingMutationSettlement,
    recordLifecycle,
    observedRuntimeDevice,
  }: {
    createdAvdNeverLaunched?: boolean;
    creationStarted: boolean;
    retainCreatedForRetry?: boolean;
    signal?: AbortSignal;
    takeLifecycleLease: () => VirtualDeviceLifecycleLease | undefined;
    error: unknown;
    unownedColdBootSettlement: Promise<void> | undefined;
    pendingMutationSettlement: Promise<unknown> | undefined;
    recordLifecycle: RecordProvisionDeviceLifecycle;
    observedRuntimeDevice: BootedDevice | undefined;
  },
): Promise<never> {
  if (
    error instanceof McpSessionRecoveryInProgressError ||
    error instanceof DaemonHandoffInterruptionError
  ) {
    // A transport routing conflict or daemon-generation handoff does not
    // invalidate the viable device, so preserve its identity for a retry
    // instead of wrapping the interruption in destructive rollback. Keep
    // the lease when an exact-provisioning mutation is still live so a
    // replacement daemon cannot recreate this identity underneath it.
    retainPendingProvisionMutationLifecycle(
      args,
      provisioned,
      takeLifecycleLease,
      pendingMutationSettlement,
    );
    throw error;
  }
  const rollbackDeadlineMs = deps.timer.now() + DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
  const target = await resolveProvisionDeviceRollbackTarget(args, deps, deviceManager, {
    provisioned,
    // The platform tool reported it created nothing, so the requested name is
    // not this request's to delete — it may be a foreign device (#11100).
    creationStarted: creationStarted && !(error instanceof ProvisionDeviceCreateRejectedError),
    observedRuntimeDevice,
    pendingMutationSettlement,
    rollbackDeadlineMs,
  });
  const provisionFailure = toProvisionDeviceError(args, error);
  if (target.kind === "unresolved") {
    return throwProvisionWithUnresolvedCreatedDevice(args, provisionFailure, {
      provisioned,
      takeLifecycleLease,
      pendingMutationSettlement,
      recordLifecycle,
    });
  }
  if (target.kind === "absent") {
    return throwProvisionWithoutCreatedDevice(provisionFailure, recordLifecycle);
  }
  const createdDevice = target.device;
  // A destructive teardown of this AVD must not race the emulator process the
  // failed attempt is still killing.
  await unownedColdBootSettlement;
  const lifecycleDevice = provisionDeviceLifecycleIdentity(
    args,
    createdDevice,
    observedRuntimeDevice,
  );
  // An abort after this decision is handled by the binding journal's terminal cleanup;
  // it remains the owner of the retained identity until retry or confirmed destruction.
  if (retainCreatedForRetry && !signal?.aborted) {
    // The binding's open creation journal owns this exact identity until retry or destruction.
    const lifecycle = {
      state: "created_not_ready" as const,
      phase: "readiness",
      device: lifecycleDevice,
      reason: provisionDeviceLifecycleReason(provisionFailure),
    };
    recordLifecycle(lifecycle);
    throw attachProvisionDeviceLifecycle(provisionFailure, lifecycle);
  }
  recordLifecycle({
    state: "cleanup_in_progress",
    phase: "cleanup",
    device: lifecycleDevice,
    reason: provisionDeviceLifecycleReason(provisionFailure),
    cleanup: { status: "in_progress", reason: "readiness_timeout" },
  });
  throw await cleanupFailedProvisionDevice(ctx, deps, createdDevice, provisionFailure, {
    createdNeverLaunched: createdAvdNeverLaunched,
    lifecycleLease: takeLifecycleLease(),
    pendingMutationSettlement: pendingMutationSettlement,
    recordLifecycle: recordLifecycle,
    lifecycleDevice: lifecycleDevice,
    rollbackDeadlineMs: rollbackDeadlineMs,
  });
}

/** What a request undone after it bound takes back, by whether it created its device. */
export function undeliveredProvisionRollback(
  ctx: ProvisioningContext,
  args: ProvisionDeviceArgs,
  provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
  {
    recordLifecycle,
    observedRuntimeDevice,
  }: {
    recordLifecycle: RecordProvisionDeviceLifecycle;
    observedRuntimeDevice: () => BootedDevice | undefined;
  },
): Pick<ProvisionBootOptions, "deleteCreatedIfUndelivered" | "recordUndeliveredAdoption"> {
  if (provisioned.created) {
    return {
      deleteCreatedIfUndelivered: async (lifecycleLease, reason) =>
        await deleteUndeliveredCreatedDevice(ctx, args, provisioned.device, {
          lifecycleLease,
          reason,
          recordLifecycle,
          observedRuntimeDevice: observedRuntimeDevice(),
        }),
    };
  }
  return {
    // The same lifecycle a cancel before the bind records for a device it did not create.
    recordUndeliveredAdoption: (reason) =>
      recordLifecycle({
        state: "no_device_created",
        phase: "provisioning",
        reason: provisionDeviceLifecycleReason(toProvisionDeviceError(args, reason)),
      }),
  };
}

/**
 * Delete the device a cancelled request created, through the failed-provision cleanup, and
 * record the outcome as the request's lifecycle so its cancellation evidence reports it.
 */
async function deleteUndeliveredCreatedDevice(
  ctx: ProvisioningContext,
  args: ProvisionDeviceArgs,
  createdDevice: DeviceInfo,
  {
    lifecycleLease,
    reason,
    recordLifecycle,
    observedRuntimeDevice,
  }: {
    lifecycleLease: VirtualDeviceLifecycleLease;
    reason: unknown;
    recordLifecycle: RecordProvisionDeviceLifecycle;
    observedRuntimeDevice: BootedDevice | undefined;
  },
): Promise<void> {
  const provisionFailure = toProvisionDeviceError(args, reason);
  const lifecycleDevice = provisionDeviceLifecycleIdentity(
    args,
    createdDevice,
    observedRuntimeDevice,
  );
  recordLifecycle({
    state: "cleanup_in_progress",
    phase: "cleanup",
    device: lifecycleDevice,
    reason: provisionDeviceLifecycleReason(provisionFailure),
    cleanup: { status: "in_progress", reason: "provisioning_failure" },
  });
  const rollback = await cleanupFailedProvisionDevice(
    ctx,
    getDeviceToolsDependencies(),
    createdDevice,
    provisionFailure,
    { lifecycleLease, recordLifecycle, lifecycleDevice },
  );
  logger.info(
    `[DeviceTools] provisionDevice rollback of created ${createdDevice.platform} device ` +
      `'${createdDevice.name}' after a cancelled request: ${rollback.cleanup.status}`,
  );
}
