import { DeviceInfo, BootedDevice, SomePlatform } from "../../../models";
import { type DevicePoolReads } from "../../../daemon/daemonContext";
import { createStructuredToolResponse } from "../../../utils/toolUtils";
import {
  type BootedDeviceDiscovery,
  type DeviceImageDiscovery,
  PlatformDeviceManager,
} from "../../../devices/deviceUtils";
import { type PooledDevice } from "../../../daemon/devicePool";
import { type VirtualDeviceLifecycleLease } from "../../../devices/virtualDeviceLifecycleCoordinator";
import {
  matchesIosTeardownIdentity,
  isVirtualAndroidDevice,
  getBootedAndroidTeardownStableName,
  isUnknownAndroidRuntimeName,
} from "../identity/androidIdentity";
import { type TeardownDeviceArgs } from "../core/contracts";
import {
  type DeviceToolsDependencies,
  POOLED_AVD_NAME_VERIFICATION_TIMEOUT_MS,
} from "../core/dependencies";

export type TeardownFailurePhase = "precondition" | "stop" | "destroy" | "verification";

/**
 * The pooled AVD label a destructive action would otherwise act on, pinned to
 * the pool INCARNATION that label belongs to.
 *
 * Captured at PREFLIGHT and re-confirmed immediately before the platform kill.
 * `reserveDeviceForShutdown` protects the captured entry from pool eviction,
 * but it cannot stop the emulator behind the serial from disappearing and being
 * replaced before discovery notices, so the epoch is re-read at the last
 * possible moment and the runtime is asked to name itself there rather than at
 * preflight (#6863 review).
 */
export interface PooledAvdCapture {
  avdName: string;
  incarnation: number;
  /**
   * The pooled entry was QUARANTINED at capture time
   * (`DevicePool.isPooledIdentityUnresolved`), so the label is not the pool's
   * statement about the runtime -- it is only the last name this daemon saw on
   * the serial. The confirmation is therefore mandatory rather than merely
   * corroborating: without a name from the runtime there is no identity at all.
   */
  quarantined?: true;
}

export type TeardownResolvedTarget =
  | {
      device: DeviceInfo;
      wasBooted: false;
    }
  | {
      device: DeviceInfo;
      wasBooted: true;
      bootedDevice: BootedDevice;
      /**
       * The pooled AVD label + epoch captured at preflight, when this target was
       * matched by a label the pool supplied rather than by a name the runtime
       * gave. Re-confirmed immediately before the platform kill (#6863 review).
       */
      pooledAvdCapture?: PooledAvdCapture;
    };

export function matchesTeardownStableId(
  device: BootedDevice,
  stableId: string,
  devicePool: DevicePoolReads | undefined,
): boolean {
  // The name-or-UDID fallback is an iOS-only concern (#6250 delete-by-name).
  // Branching explicitly on platform keeps a physical Android device whose
  // `name` happens to collide with an unrelated target's stableId from being
  // captured by that fallback; Android keeps matching by stable AVD name /
  // deviceId only.
  if (device.platform === "ios") {
    return matchesIosTeardownIdentity(device, stableId);
  }
  return isVirtualAndroidDevice(device)
    ? getBootedAndroidTeardownStableName(device, devicePool) === stableId
    : device.deviceId === stableId;
}

export function teardownDeadlineDevice(args: TeardownDeviceArgs): BootedDevice {
  return {
    platform: args.target.platform,
    name: args.target.stableId,
    deviceId: args.target.stableId,
  };
}

export function createTeardownResponse(
  args: TeardownDeviceArgs,
  state: "destroyed" | "already_absent",
  command: { stop: "accepted" | "not_required"; destroy: "accepted" | "not_required" },
  verification: { notRunning: "confirmed"; inventory: "complete_absence_confirmed" },
  resolved?: DeviceInfo,
  timing?: unknown,
) {
  return createStructuredToolResponse({
    mode: args.mode,
    state,
    target: {
      stableId: args.target.stableId,
      stableName: args.target.stableName,
      platform: resolved?.platform ?? args.target.platform,
      isVirtual: args.target.isVirtual,
    },
    command,
    verification,
    timing,
  });
}

export function createTeardownFailureResponse(
  args: TeardownDeviceArgs,
  phase: TeardownFailurePhase,
  code: string,
  message: string,
  resolved?: DeviceInfo,
  /** Typed refusal evidence carried beside the code (e.g. the broker binding holding the device). */
  details?: Record<string, unknown>,
) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: message,
          mode: args.mode,
          state: "failed",
          target: {
            stableId: args.target.stableId,
            stableName: args.target.stableName,
            platform: resolved?.platform ?? args.target.platform,
            isVirtual: args.target.isVirtual,
          },
          failure: { ...details, code, phase, message },
        }),
      },
    ],
  };
}

export function findMatchingBootedTeardownDevices(
  discovery: BootedDeviceDiscovery,
  args: TeardownDeviceArgs,
  devicePool: DevicePoolReads | undefined,
): BootedDevice[] {
  return discovery.devices.filter(
    (device) =>
      device.platform === args.target.platform &&
      matchesTeardownStableId(device, args.target.stableId, devicePool),
  );
}

export function createBootedTeardownTarget(
  device: BootedDevice,
  args: TeardownDeviceArgs,
  devicePool: DevicePoolReads | undefined,
): { target?: TeardownResolvedTarget; conflict?: string; unsupported?: string } {
  const stableName =
    device.platform === "android"
      ? getBootedAndroidTeardownStableName(device, devicePool)
      : device.name;
  if (args.target.stableName && args.target.stableName !== stableName) {
    return { conflict: "The requested stable name does not match the booted device identity." };
  }
  if (device.platform === "android" && !isVirtualAndroidDevice(device)) {
    return {
      unsupported:
        "Physical Android devices do not have a deletable platform device representation.",
    };
  }
  return {
    target: {
      device: {
        ...device,
        name: stableName,
        isRunning: true,
      },
      wasBooted: true,
      bootedDevice: {
        ...device,
        name: stableName,
      },
    },
  };
}

export function findBootedTeardownTarget(
  discovery: BootedDeviceDiscovery,
  args: TeardownDeviceArgs,
  devicePool: DevicePoolReads | undefined,
): { target?: TeardownResolvedTarget; conflict?: string; unsupported?: string } {
  const matchingId = findMatchingBootedTeardownDevices(discovery, args, devicePool);
  if (matchingId.length > 1) {
    return { conflict: "Multiple booted devices matched the requested stable ID." };
  }
  const device = matchingId[0];
  if (device) {
    if (
      device.platform === "android" &&
      isUnknownAndroidRuntimeName(device) &&
      !devicePool?.getDevice(device.deviceId)?.avdName
    ) {
      return {
        unsupported:
          "Cannot safely identify the requested booted Android AVD because its runtime name is unknown.",
      };
    }
    return createBootedTeardownTarget(device, args, devicePool);
  }
  return {};
}

export function findInventoryTeardownTarget(
  discovery: DeviceImageDiscovery,
  args: TeardownDeviceArgs,
): { target?: TeardownResolvedTarget; conflict?: string } {
  const matches = discovery.devices.filter(
    (device) =>
      device.platform === args.target.platform &&
      (device.platform === "ios"
        ? matchesIosTeardownIdentity(device, args.target.stableId)
        : device.name === args.target.stableId),
  );
  if (matches.length > 1) {
    return {
      conflict: "Multiple platform device representations matched the requested stable ID.",
    };
  }
  const device = matches[0];
  if (device && args.target.stableName && args.target.stableName !== device.name) {
    return { conflict: "The requested stable name does not match the platform device identity." };
  }
  return device ? { target: { device: { ...device, isRunning: false }, wasBooted: false } } : {};
}

export function inventoryContainsTarget(
  discovery: DeviceImageDiscovery,
  target: TeardownResolvedTarget,
): boolean {
  return discovery.devices.some(
    (device) =>
      device.platform === target.device.platform &&
      (device.platform === "ios"
        ? device.deviceId === target.device.deviceId
        : device.name === target.device.name),
  );
}

export function completedInventoryFor(
  discovery: { succeededPlatforms: Set<SomePlatform> },
  platform: SomePlatform,
): boolean {
  return discovery.succeededPlatforms.has(platform);
}

export type TeardownToolResponse =
  | ReturnType<typeof createTeardownResponse>
  | ReturnType<typeof createTeardownFailureResponse>;

export type TeardownResolution =
  | { target: TeardownResolvedTarget }
  | { response: TeardownToolResponse };

export interface TeardownInitialAndroidScan {
  serials: Set<string>;
  pooledEntries: PooledDevice[];
}

/** Private lifecycle evidence; never accepted by the public deleteDevice schema. */
export interface InternalTeardownOptions {
  unlaunchedCreatedAvd?: { stableId: string };
}

export interface TeardownContext {
  args: TeardownDeviceArgs;
  dependencies: DeviceToolsDependencies;
  deviceManager: PlatformDeviceManager;
  requestAbortSignal: AbortSignal | undefined;
  deadlineDevice: BootedDevice;
  deadlineMs: number;
  timeoutMs: number;
  cancelOnRequestAbort: boolean;
  lifecycleLease?: VirtualDeviceLifecycleLease;
  /** Request-created Android image whose provisioning request never attempted boot; requires the matching lease. */
  unlaunchedCreatedAvd?: InternalTeardownOptions["unlaunchedCreatedAvd"];
  /** A local unnamed runtime veto was bypassed using never-launched proof; process evidence must prove absence. */
  localSiblingVetoSkipped?: boolean;
  /** Android runtime and pool state captured by the first teardown booted scan. */
  initialScan: TeardownInitialAndroidScan;
  /**
   * Unnamed foreign emulators resolution read and cleared (they ran a different AVD). Their serials
   * are re-read before the image is deleted, even if discovery stops marking them foreign by then.
   */
  clearedForeignSerials?: Set<string>;
  /**
   * `force` exists to escape wedged emulator consoles, so every Android
   * discovery run for THIS teardown must stay serial-only rather than
   * re-probing consoles one call site at a time (#6946). Computed once at
   * context construction so a new discovery added to this flow inherits the
   * mode automatically instead of silently reintroducing a name-aware scan.
   */
  mode: "named" | "serial-only";
}

export function teardownProbeBudget(context: TeardownContext): {
  signal: AbortSignal | undefined;
  remainingMs: number;
} {
  return {
    signal: context.requestAbortSignal,
    remainingMs: Math.min(
      POOLED_AVD_NAME_VERIFICATION_TIMEOUT_MS,
      context.deadlineMs - context.dependencies.timer.now(),
    ),
  };
}

export function captureTeardownInitialAndroidScan(
  booted: BootedDeviceDiscovery,
  devicePool: DevicePoolReads | undefined,
): TeardownInitialAndroidScan {
  return {
    serials: new Set(
      booted.devices
        .filter((device) => device.platform === "android")
        .map((device) => device.deviceId),
    ),
    pooledEntries:
      devicePool?.getAllDevices().filter((device) => device.platform === "android") ?? [],
  };
}
