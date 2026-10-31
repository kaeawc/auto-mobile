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
  StableDeviceTarget,
  reserveStableDeviceLifecycle,
  rethrowDeviceLifecycleReservationFailure,
  runProvisionDeviceWithinDeadline,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import {
  exactIosProvisionDeviceIdentity,
  findExactIosProvisionDeviceCandidate,
} from "./provisioningRollbackTarget";
import { admitRestartReservedProvision, releaseProvisionReadiness } from "./provisioningSession";
import { type ProvisionSettlementState } from "./provisioningTypes";

export async function reserveExistingIosProvisionDeviceLifecycle(
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  deviceManager: PlatformDeviceManager,
  { totalDeadlineMs, signal }: { totalDeadlineMs: number; signal?: AbortSignal },
): Promise<VirtualDeviceLifecycleLease | undefined> {
  const discovery = await runProvisionDeviceWithinDeadline(deps.timer, totalDeadlineMs, signal, {
    operation: async (deadlineSignal) =>
      await deviceManager.getDeviceImagesDetailed("ios", {
        bypassIosDeviceListCache: true,
        signal: deadlineSignal,
      }),
    phase: "resolving the exact iOS simulator identity",
  });
  if (!discovery.succeededPlatforms.has("ios")) {
    throw new ProvisionDeviceError(
      "platform_command_failed",
      `Cannot provision iOS device '${args.device.name}' because simulator identity discovery did not complete.`,
    );
  }
  const existing = findExactIosProvisionDeviceCandidate(
    exactIosProvisionDeviceIdentity(args),
    discovery.devices,
  );
  if (!existing?.deviceId) {
    if (args.device.deviceId) {
      return await reserveIosProvisionDeviceLifecycle(
        args,
        deps,
        { deviceId: args.device.deviceId },
        { totalDeadlineMs, signal },
      );
    }
    return undefined;
  }
  admitRestartReservedProvision(args, existing.deviceId);
  return await reserveIosProvisionDeviceLifecycle(args, deps, existing, {
    totalDeadlineMs,
    signal,
  });
}

/**
 * Reserve a not-yet-created iOS simulator by name. This is the one provision
 * reservation with no stable identity to key on, so it maps a post-deadline
 * coordinator rejection to the same `ProvisionDeviceError("timeout")` the
 * stable paths raise instead of leaking an opaque platform failure.
 */
export async function reserveIosSelectorProvisionDeviceLifecycle(
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  totalDeadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<VirtualDeviceLifecycleLease> {
  try {
    return await deps.lifecycleCoordinator.reserve(
      { kind: "selector", platform: "ios", selector: args.device.name },
      { operation: "provision", deadlineMs: totalDeadlineMs, signal },
    );
  } catch (error) {
    rethrowDeviceLifecycleReservationFailure(error, deps.timer, totalDeadlineMs, {
      timeoutError: (detail) =>
        new ProvisionDeviceError(
          "timeout",
          `Timed out provisioning ios device '${args.device.name}': ${detail}.`,
        ),
      timeoutDetail: "waiting for the device lifecycle reservation",
    });
  }
}

async function reserveIosProvisionDeviceLifecycle(
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  device: Pick<DeviceInfo, "deviceId">,
  { totalDeadlineMs, signal }: { totalDeadlineMs: number; signal?: AbortSignal },
): Promise<VirtualDeviceLifecycleLease> {
  if (!device.deviceId) {
    throw new ProvisionDeviceError(
      "identity_conflict",
      `Exact iOS simulator '${args.device.name}' has no UDID.`,
    );
  }
  const target: StableDeviceTarget = { platform: "ios", stableId: device.deviceId };
  return await reserveStableDeviceLifecycle(
    target,
    {
      platform: target.platform,
      name: args.device.name,
      deviceId: target.stableId,
    },
    deps.timer,
    {
      deadlineMs: totalDeadlineMs,
      requestAbortSignal: signal,
      timeoutError: (detail) =>
        new ProvisionDeviceError(
          "timeout",
          `Timed out provisioning ${target.platform} device '${args.device.name}': ${detail}.`,
        ),
      operation: "provision",
      coordinator: deps.lifecycleCoordinator,
    },
  );
}

export function provisionDeviceLifecycleIdentity(
  args: ProvisionDeviceArgs,
  provisioned: DeviceInfo,
  runtimeDevice?: BootedDevice,
): NonNullable<ProvisionDeviceLifecycleOutcome["device"]> {
  const stableId =
    args.device.platform === "android"
      ? args.device.name
      : (provisioned.deviceId ?? args.device.deviceId ?? args.device.name);
  return {
    platform: args.device.platform,
    stableId,
    name: provisioned.name,
    ...(runtimeDevice?.deviceId ? { runtimeDeviceId: runtimeDevice.deviceId } : {}),
  };
}

export function prebootProvisionDeviceLifecycle(
  args: ProvisionDeviceArgs,
  provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
): ProvisionDeviceLifecycleOutcome {
  return {
    state: "created_not_ready",
    phase: provisioned.created ? "created" : "adopted",
    device: provisionDeviceLifecycleIdentity(args, provisioned.device),
  };
}

export function releaseProvisionLifecycleReservations(
  settlementState: ProvisionSettlementState,
  getLifecycleLease: () => VirtualDeviceLifecycleLease | undefined,
): void {
  const settlements = [
    ...settlementState.bindingSettlements,
    ...(settlementState.unownedColdBootSettlement
      ? [settlementState.unownedColdBootSettlement]
      : []),
  ];
  if (settlements.length > 0) {
    // A cancelled autolock binding may still be durably releasing its
    // session. Keep both identity reservations until that rollback (and
    // any cold-boot shutdown) is terminal, without delaying the caller.
    void Promise.allSettled(settlements)
      .then(() => {
        releaseProvisionReadiness(settlementState.readinessReservation);
        getLifecycleLease()?.release();
      })
      .catch((error: unknown) => {
        logger.warn(
          `[DeviceTools] Deferred provision reservation release failed: ${errorMessage(error)}`,
          error,
        );
      });
  } else {
    releaseProvisionReadiness(settlementState.readinessReservation);
    getLifecycleLease()?.release();
  }
}
