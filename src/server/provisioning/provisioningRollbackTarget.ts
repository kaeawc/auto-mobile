import { errorMessage } from "../../utils/describeUnknownError";
import { PlatformDeviceManager } from "../../devices/deviceUtils";
import { BootedDevice, DeviceInfo } from "../../models";
import { logger } from "../../utils/logger";
import {
  type ExactDeviceProvisioner,
  ProvisionDeviceError,
} from "../../devices/exactDeviceProvisioning";
import type { ProvisionDeviceLifecycleOutcome } from "../../devices/provisionDeviceLifecycle";
import { type VirtualDeviceLifecycleLease } from "../../devices/virtualDeviceLifecycleCoordinator";
import {
  DeviceToolsDependencies,
  ProvisionDeviceArgs,
  ProvisionDeviceRollbackError,
  RecordProvisionDeviceLifecycle,
  attachProvisionDeviceLifecycle,
  runOperationWithinDeadline,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import { type ExactIosDeviceIdentity, type ProvisionRollbackTarget } from "./provisioningTypes";
import {
  provisionMutationSettledWithinRollbackBudget,
  retainPendingProvisionMutationLifecycle,
} from "./provisioningCleanup";
import { provisionDeviceLifecycleReason } from "./provisioningErrors";

/**
 * The exact-identity filter shared by iOS lifecycle reservation and rollback:
 * a simulator only matches when its name, runtime and device type all match
 * the request, preferring an available one over an unavailable duplicate.
 */
export function findExactIosProvisionDeviceCandidate(
  identity: ExactIosDeviceIdentity,
  devices: DeviceInfo[],
): DeviceInfo | undefined {
  if (identity.deviceId) {
    return devices.find(
      (device) => device.platform === "ios" && device.deviceId === identity.deviceId,
    );
  }
  const candidates = devices.filter(
    (device) =>
      device.platform === "ios" &&
      device.name === identity.name &&
      device.deviceId &&
      device.runtime === identity.runtime &&
      device.deviceType === identity.deviceType,
  );
  return candidates.find((device) => device.isAvailable !== false) ?? candidates[0];
}

export function exactIosProvisionDeviceIdentity(args: ProvisionDeviceArgs): ExactIosDeviceIdentity {
  return {
    name: args.device.name,
    deviceId: args.device.deviceId,
    runtime: args.device.spec.runtime,
    deviceType: args.device.spec.deviceType,
  };
}

/**
 * Rollback target for an iOS simulator created before provisioning failed.
 * `onBeforeCreate` only fires once the provisioner has established that no
 * matching simulator existed, so a match found now is the one this operation
 * created — the iOS equivalent of Android's name-keyed fallback target.
 *
 * A `simctl create` still in flight can land after a discovery that ran too
 * early, so discovery waits for that mutation to settle first, and both the
 * wait and the discovery are bounded by the rollback deadline. Only a
 * completed discovery that runs after the mutation settled may report
 * `absent`; anything else is `unresolved` (#11064).
 */
async function resolveCreatedIosProvisionDeviceRollbackTarget(
  identity: ExactIosDeviceIdentity,
  deps: DeviceToolsDependencies,
  deviceManager: PlatformDeviceManager,
  pendingMutationSettlement: Promise<unknown> | undefined,
  rollbackDeadlineMs: number,
): Promise<ProvisionRollbackTarget> {
  if (
    pendingMutationSettlement &&
    !(await provisionMutationSettledWithinRollbackBudget(
      deps,
      pendingMutationSettlement,
      rollbackDeadlineMs,
    ))
  ) {
    logger.warn(
      `[DeviceTools] Cannot roll back iOS simulator '${identity.name}': its creation did not settle within the rollback budget.`,
    );
    return { kind: "unresolved" };
  }
  try {
    const discovery = await runOperationWithinDeadline(deps.timer, rollbackDeadlineMs, undefined, {
      operation: async (deadlineSignal) =>
        await deviceManager.getDeviceImagesDetailed("ios", {
          bypassIosDeviceListCache: true,
          signal: deadlineSignal,
        }),
      timeoutError: () => new Error("iOS rollback identity discovery exceeded the rollback budget"),
    });
    if (!discovery.succeededPlatforms.has("ios")) {
      logger.warn(
        `[DeviceTools] Cannot roll back iOS simulator '${identity.name}': identity discovery did not complete.`,
      );
      return { kind: "unresolved" };
    }
    const device = findExactIosProvisionDeviceCandidate(identity, discovery.devices);
    return device ? { kind: "device", device } : { kind: "absent" };
  } catch (error) {
    logger.warn(
      `[DeviceTools] Failed to resolve the iOS rollback target for '${identity.name}': ${errorMessage(error)}`,
      error,
    );
    return { kind: "unresolved" };
  }
}

export async function resolveProvisionDeviceRollbackTarget(
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  deviceManager: PlatformDeviceManager,
  {
    provisioned,
    creationStarted,
    observedRuntimeDevice,
    pendingMutationSettlement,
    rollbackDeadlineMs,
  }: {
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined;
    creationStarted: boolean;
    observedRuntimeDevice: BootedDevice | undefined;
    pendingMutationSettlement: Promise<unknown> | undefined;
    rollbackDeadlineMs: number;
  },
): Promise<ProvisionRollbackTarget> {
  if (!provisioned?.created && !creationStarted) {
    return { kind: "absent" };
  }
  const target: ProvisionRollbackTarget = provisioned
    ? { kind: "device", device: provisioned.device }
    : args.device.platform === "android"
      ? {
          kind: "device",
          device: { name: args.device.name, platform: "android" as const, isRunning: false },
        }
      : await resolveCreatedIosProvisionDeviceRollbackTarget(
          exactIosProvisionDeviceIdentity(args),
          deps,
          deviceManager,
          pendingMutationSettlement,
          rollbackDeadlineMs,
        );
  if (target.kind !== "device" || !observedRuntimeDevice?.deviceId) {
    return target;
  }
  return {
    kind: "device",
    device: { ...target.device, deviceId: observedRuntimeDevice.deviceId },
  };
}

/**
 * A simulator may exist that this operation created, but its identity is
 * unknown: record it retained with unknown ownership (never
 * `no_device_created`) and keep the lifecycle lease until the creating
 * mutation settles, so no other operation can claim the name underneath it.
 */
export function throwProvisionWithUnresolvedCreatedDevice(
  args: ProvisionDeviceArgs,
  provisionFailure: ProvisionDeviceError,
  {
    provisioned,
    takeLifecycleLease,
    pendingMutationSettlement,
    recordLifecycle,
  }: {
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined;
    takeLifecycleLease: () => VirtualDeviceLifecycleLease | undefined;
    pendingMutationSettlement: Promise<unknown> | undefined;
    recordLifecycle: RecordProvisionDeviceLifecycle;
  },
): never {
  retainPendingProvisionMutationLifecycle(
    args,
    provisioned,
    takeLifecycleLease,
    pendingMutationSettlement,
  );
  const rollbackError = new ProvisionDeviceRollbackError(provisionFailure, {
    status: "failed",
    target: {
      platform: args.device.platform,
      isVirtual: true,
      stableId: args.device.deviceId ?? args.device.name,
      stableName: args.device.name,
    },
    failure: {
      code: "target_identity_unresolved",
      phase: "precondition",
      message:
        "A device may have been created, but its exact identity could not be resolved within the rollback budget; it was not removed.",
    },
  });
  const lifecycle: ProvisionDeviceLifecycleOutcome = {
    state: "retained",
    phase: "cleanup",
    reason: provisionDeviceLifecycleReason(provisionFailure),
    cleanup: {
      status: "failed",
      reason: "target_identity_unresolved",
    },
  };
  recordLifecycle(lifecycle);
  throw attachProvisionDeviceLifecycle(rollbackError, lifecycle);
}

export function throwProvisionWithoutCreatedDevice(
  provisionFailure: ProvisionDeviceError,
  recordLifecycle: RecordProvisionDeviceLifecycle,
): never {
  const lifecycle: ProvisionDeviceLifecycleOutcome = {
    state: "no_device_created",
    phase: "provisioning",
    reason: provisionDeviceLifecycleReason(provisionFailure),
  };
  recordLifecycle(lifecycle);
  throw attachProvisionDeviceLifecycle(provisionFailure, lifecycle);
}

export async function resolveCreatedIosRollbackTargetForAcquisition(
  createdDevice: DeviceInfo,
  {
    deps,
    pendingMutationSettlement,
    rollbackDeadlineMs,
  }: {
    deps: DeviceToolsDependencies;
    pendingMutationSettlement: Promise<unknown> | undefined;
    rollbackDeadlineMs: number;
  },
): Promise<ProvisionRollbackTarget> {
  if (!createdDevice.runtime || !createdDevice.deviceType) {
    logger.warn(
      `[DeviceTools] Cannot roll back iOS simulator '${createdDevice.name}': its runtime and device type are unknown.`,
    );
    return { kind: "unresolved" };
  }
  return await resolveCreatedIosProvisionDeviceRollbackTarget(
    {
      name: createdDevice.name,
      runtime: createdDevice.runtime,
      deviceType: createdDevice.deviceType,
    },
    deps,
    deps.deviceManagerFactory(),
    pendingMutationSettlement,
    rollbackDeadlineMs,
  );
}
