import { errorMessage } from "../../utils/describeUnknownError";
import { DeviceInfo } from "../../models";
import { logger } from "../../utils/logger";
import { DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import { ProvisionDeviceError } from "../../devices/exactDeviceProvisioning";
import {
  ProvisionDeviceCleanup,
  getDeviceToolsDependencies,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import type { CreatedDeviceRollback } from "../deviceToolsStartDevice";
import { resolveCreatedIosRollbackTargetForAcquisition } from "./provisioningRollbackTarget";
import { cleanupFailedProvisionDevice } from "./provisioningCleanup";
import type { ProvisioningContext } from "./provisioningTypes";

/**
 * Roll back a device a startDevice `createIfMissing` acquisition created but
 * could not bind or boot, through the same teardown provisionDevice's own
 * rollback uses, so retries do not accumulate orphans (#11100).
 */
export async function rollbackCreatedDevice(
  ctx: ProvisioningContext,
  createdDevice: DeviceInfo,
  failure: unknown,
  {
    lifecycleLease,
    pendingMutationSettlement,
    collectDeferredCleanup,
  }: Parameters<CreatedDeviceRollback>[2],
): Promise<ProvisionDeviceCleanup> {
  const deps = getDeviceToolsDependencies();
  const provisionFailure =
    failure instanceof ProvisionDeviceError
      ? failure
      : new ProvisionDeviceError("platform_command_failed", errorMessage(failure));
  const rollbackDeadlineMs = deps.timer.now() + DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
  let target = createdDevice;
  if (createdDevice.platform === "ios" && !createdDevice.deviceId) {
    // The create was cancelled or timed out before simctl reported a UDID:
    // find what it created by exact identity once it has settled (#11155).
    const resolved = await resolveCreatedIosRollbackTargetForAcquisition(createdDevice, {
      deps,
      pendingMutationSettlement,
      rollbackDeadlineMs,
    });
    if (resolved.kind === "absent") {
      return createdDeviceRollbackSkipped(createdDevice, "absent");
    }
    if (resolved.kind === "unresolved") {
      retryUnresolvedCreatedDeviceRollback(ctx, createdDevice, failure, {
        lifecycleLease,
        pendingMutationSettlement,
        collectDeferredCleanup,
      });
      return createdDeviceRollbackSkipped(createdDevice, "unresolved");
    }
    target = resolved.device;
  }
  const rollback = await cleanupFailedProvisionDevice(ctx, deps, target, {
    provisionFailure,
    lifecycleLease,
    pendingMutationSettlement,
    rollbackDeadlineMs,
    collectDeferredCleanup,
  });
  return rollback.cleanup;
}

/**
 * The create had not settled within the rollback budget: once it does, retry
 * the rollback with a fresh budget. The retry is handed to the caller's
 * deferred cleanups, which keep the lifecycle lease held until it finishes.
 */
function retryUnresolvedCreatedDeviceRollback(
  ctx: ProvisioningContext,
  createdDevice: DeviceInfo,
  failure: unknown,
  options: Parameters<CreatedDeviceRollback>[2],
): void {
  const { pendingMutationSettlement, collectDeferredCleanup } = options;
  if (!pendingMutationSettlement || !collectDeferredCleanup) {
    return;
  }
  const retry = async (): Promise<void> => {
    const cleanup = await rollbackCreatedDevice(ctx, createdDevice, failure, {
      ...options,
      pendingMutationSettlement: undefined,
    });
    if (cleanup.status === "failed") {
      logger.warn(
        `[DeviceTools] Deferred rollback of created iOS simulator '${createdDevice.name}' failed: ` +
          `${cleanup.failure?.message ?? "unknown cleanup failure"}`,
      );
    } else {
      logger.info(
        `[DeviceTools] Deferred createIfMissing rollback of created iOS simulator ` +
          `'${createdDevice.name}' (id=${cleanup.target.stableId}) after: ${errorMessage(failure)}; ` +
          `outcome: succeeded${cleanup.state ? ` (${cleanup.state})` : ""}`,
      );
    }
  };
  collectDeferredCleanup(
    pendingMutationSettlement.then(retry, retry).catch((error: unknown) => {
      logger.warn(
        `[DeviceTools] Deferred rollback of created iOS simulator '${createdDevice.name}' rejected: ${errorMessage(error)}`,
        error,
      );
    }),
  );
}

function createdDeviceRollbackSkipped(
  createdDevice: DeviceInfo,
  outcome: "absent" | "unresolved",
): ProvisionDeviceCleanup {
  const target: ProvisionDeviceCleanup["target"] = {
    platform: createdDevice.platform,
    isVirtual: true,
    stableId: createdDevice.deviceId ?? createdDevice.name,
    stableName: createdDevice.name,
  };
  return outcome === "absent"
    ? { status: "succeeded", target, state: "absent" }
    : {
        status: "failed",
        target,
        failure: {
          code: "target_identity_unresolved",
          phase: "precondition",
          message:
            "A simulator may have been created, but its exact identity could not be resolved; it was not removed.",
        },
      };
}
