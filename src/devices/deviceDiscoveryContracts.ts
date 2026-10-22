import { ActionableError, BootedDevice, DeviceInfo, Platform, SomePlatform } from "../models";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../models/BootedDeviceDiscoveryIncompleteError";
import type {
  DeviceDiscoveryError,
  DeviceDiscoveryErrorCode,
} from "../models/DeviceDiscoveryError";
import type { SimulatorWorkloadProfile } from "../models/DeviceResourceReconciliation";
import type { TransitionalSimulator } from "../models/TransitionalSimulator";
import { getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import {
  AdbCommandTimeoutError,
  AdbUnavailableError,
} from "../utils/android-cmdline-tools/AdbClient";
import type {
  AndroidEmulatorLaunchOutcome,
  AndroidEmulatorReadinessOptions,
} from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import type { EmulatorProcessStopper } from "../utils/android-cmdline-tools/EmulatorProcessStop";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import type { DiscoverySource } from "../utils/discoverySource";
import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import { SimctlUnavailableError, type SimCtl } from "../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../utils/logger";
import { runPhaseWithSettlement } from "../utils/runPhaseWithSettlement";
import { defaultTimer } from "../utils/SystemTimer";
import { type VirtualDeviceLifecycleLease } from "./virtualDeviceLifecycleCoordinator";
import type { WaitForDeviceReadyOrCancelOptions } from "./WaitForDeviceReadyOrCancelOptions";

// Pool allocation deadlines must not advance while a non-cooperative readiness wait settles.
// A bounded microtask wait lets cooperative promise rejections surface before cleanup.
export const READINESS_ABORT_SETTLEMENT_GRACE_MS = 0;

/**
 * A configured Android image with incomplete ADB liveness must not be used for
 * a cold boot: it may already be running behind the unavailable overlay.
 */
export function assertAndroidImageRunningStateKnown(image: DeviceInfo): void {
  if (image.platform === "android" && image.isRunningStateKnown === false) {
    throw new AndroidBootedDeviceDiscoveryIncompleteError(
      undefined,
      `Cannot safely cold-boot Android AVD '${image.name}': its running state is unknown.`,
    );
  }
}

/**
 * Result of a discovery sweep that distinguishes per-platform success.
 *
 * `succeededPlatforms` only contains platforms whose discovery tooling was
 * reachable and completed (even if it found zero devices). A platform absent
 * from the set had a failed or unavailable discovery this sweep, so its tracked
 * devices must not be treated as gone (no pruning / disconnect detection).
 */
export interface BootedDeviceDiscovery {
  devices: BootedDevice[];
  succeededPlatforms: Set<Platform>;
  /**
   * Per-source completeness, one level finer than `succeededPlatforms` (#5683).
   *
   * iOS is discovered by two independent sources, so the platform flag alone
   * cannot say which half of a mixed outcome is authoritative. Consumers that
   * decide assignability or pruning for an individual device must ask
   * `didSourceSucceedForDevice` rather than reading the platform aggregate.
   */
  succeededSources?: Set<DiscoverySource>;
  /**
   * Devices this sweep **freshly** observed, as opposed to replayed from a
   * retained listing (#5683).
   *
   * Membership proves the device was observed this sweep rather than replayed.
   */
  freshDeviceIds?: Set<string>;
  sourceErrors?: Partial<Record<DiscoverySource, DeviceDiscoveryError>>;
  /** Platform-specific typed failures for incomplete observations. */
  discoveryErrors?: Partial<Record<Platform, DeviceDiscoveryError>>;
  /**
   * Simulators `simctl` reports `Booting` or `Shutting Down`. They are not in `devices` (not
   * booted), but a session holding one must still see it on every inventory surface (#11573).
   * Present only when the simulator source completed; absent means unknown, not none.
   */
  transitionalSimulators?: TransitionalSimulator[];
}

/**
 * A missing adb binary (ENOENT, surfaced by the adb client as `AdbUnavailableError`) is not a
 * failed sweep: Android does not apply to this host, so it is `unavailable` (#11605).
 */
export function androidDiscoveryErrorCode(error: unknown): DeviceDiscoveryErrorCode {
  if (error instanceof AdbCommandTimeoutError) {
    return "timeout";
  }
  return error instanceof AdbUnavailableError ? "unavailable" : "failed";
}

/** xcrun/simctl not installed is not a failed sweep: simulators do not apply to this host (#11605). */
export function simulatorDiscoveryErrorCode(error: unknown): DeviceDiscoveryErrorCode {
  return error instanceof SimctlUnavailableError ? "unavailable" : "failed";
}

/** The iOS sources that completed, from one sweep's per-source outcome. */
export function iosSucceededSources(outcome: {
  simulatorsSucceeded: boolean;
  physicalSucceeded: boolean;
}): DiscoverySource[] {
  return [
    ...(outcome.simulatorsSucceeded ? (["ios-simulator"] as const) : []),
    ...(outcome.physicalSucceeded ? (["ios-physical"] as const) : []),
  ];
}

export interface BootedDeviceDiscoveryOptions {
  coalesceInventoryEnrichment?: boolean;
  /** Read listings only: reuse Android AVD names on the same ADB connection briefly. */
  memoizeReadAvdNames?: boolean;
  /** Bypass Android's short device-list cache to verify ADB transport identity. */
  bypassAndroidDeviceListCache?: boolean;
  /** Bypass iOS's short simulator-list cache to verify simulator identity. */
  bypassIosDeviceListCache?: boolean;
  /** Require a new physical iOS listing before counting an absence. */
  bypassPhysicalIosDeviceListCache?: boolean;
  /**
   * Skip devicectl physical-device discovery. For a caller that already holds a
   * simulator UDID, a physical sweep can neither find nor prove anything and only
   * adds latency (#9920). The result then reports no physical source as succeeded.
   */
  skipPhysicalIosDiscovery?: boolean;
  /** Cancels short-lived platform discovery work. */
  signal?: AbortSignal;
  /**
   * Acceptance-only presentation seam. It reorders an otherwise identical,
   * freshly discovered result and never changes device state.
   */
  presentationOrder?: "forward" | "reverse";
  /**
   * List what Android has attached and ask it nothing else: no `emu avd name`,
   * no getprop fallback. See `AndroidEmulatorClient`'s `skipNameEnrichment` --
   * enrichment is sequential and budgets 2s per attached device, so a caller
   * that has already committed to ignoring the names must not pay for them
   * ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review). Every
   * emulator comes back under `Unknown (<serial>)`, so nothing that still
   * compares names may set this.
   */
  skipAndroidNameEnrichment?: boolean;
  /** Monitor discovery retains AVD identity but omits model, architecture and displays. */
  skipAndroidProfileEnrichment?: boolean;
  /** Restrict Android enrichment to this serial; other attached devices are neither probed nor returned. */
  androidTargetDeviceId?: string;
}

export interface DeviceImageDiscovery {
  devices: DeviceInfo[];
  succeededPlatforms: Set<Platform>;
  /** Platform-specific typed failures for incomplete observations. */
  discoveryErrors?: Partial<Record<Platform, DeviceDiscoveryError>>;
}

export function presentBootedDevices(
  devices: BootedDevice[],
  presentationOrder: BootedDeviceDiscoveryOptions["presentationOrder"],
): BootedDevice[] {
  return presentationOrder === "reverse" ? devices.toReversed() : devices;
}

export interface DeviceImageDiscoveryOptions {
  coalesceInventoryEnrichment?: boolean;
  /** Bypass simulator inventory caching when durable absence must be proven. */
  bypassIosDeviceListCache?: boolean;
  /** Cancels short-lived platform image discovery work. */
  signal?: AbortSignal;
}

/** Bounds and cancels a platform shutdown command. */
export interface DeviceShutdownOptions {
  processStop?: { stopper: EmulatorProcessStopper; expectedAvdName?: string };
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Act on whatever occupies the target's serial rather than comparing the
   * requested AVD name against a fresh discovery (#6864). Android emulators
   * only; iOS shutdown has no equivalent identity comparison to drop.
   */
  force?: boolean;
}

/** Bounds and cancels a platform representation deletion. */
export interface DeviceDestroyOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Existing teardown lease held by a higher-level orchestrator. */
  lifecycleLease?: VirtualDeviceLifecycleLease;
}

/** Options applied only when starting a new virtual-device process. */
export interface DeviceStartOptions {
  cameraPosterPath?: string;
  /** iOS only: the resource profile this boot is for, so boot durations compare per profile. */
  resourceProfile?: SimulatorWorkloadProfile;
}

/**
 * A device start and how it obtained the device. An iOS boot is always `launched`; Android
 * outcomes are described on {@link AndroidEmulatorLaunchOutcome}. Only `launched` carries a
 * process this start created.
 */
export interface DeviceStartResult {
  process: ChildProcess | null;
  outcome: AndroidEmulatorLaunchOutcome;
}

/** Platform-agnostic device management for Android emulators and iOS simulators. */
export interface PlatformDeviceManager {
  /**
   * List all available device images for a specific platform
   * @param platform - Target platform ("android", "ios", or "either" for both)
   * @param signal - Optional caller abort; cancels the Android `emulator
   *   -list-avds` child so a stalled listing cannot outlive a caller's deadline.
   * @returns Promise with array of available device information
   */
  listDeviceImages(platform: SomePlatform, signal?: AbortSignal): Promise<DeviceInfo[]>;

  /**
   * Check if a specific device image is currently running
   * @param device - The device info to check
   * @returns Promise with boolean indicating if the device image is running
   */
  isDeviceImageRunning(device: DeviceInfo): Promise<boolean>;

  /**
   * Get all currently booted/running devices for a specific platform
   * @param platform - Target platform ("android", "ios", or "either" for both)
   * @returns Promise with array of booted device information
   */
  getBootedDevices(platform: SomePlatform): Promise<BootedDevice[]>;

  /**
   * Get all currently booted devices along with which platforms were
   * successfully discovered. Unlike {@link getBootedDevices}, a platform whose
   * discovery tooling failed or was unavailable is reported as un-discovered
   * rather than collapsing into an empty device list, so callers can avoid
   * pruning devices on a transient/partial discovery failure.
   * @param platform - Target platform ("android", "ios", or "either" for both)
   */
  getBootedDevicesDetailed(
    platform: SomePlatform,
    options?: BootedDeviceDiscoveryOptions,
  ): Promise<BootedDeviceDiscovery>;

  /**
   * Get all platform device representations along with which platform
   * inventories completed. A missing platform cannot prove durable absence.
   */
  getDeviceImagesDetailed(
    platform: SomePlatform,
    options?: DeviceImageDiscoveryOptions,
  ): Promise<DeviceImageDiscovery>;

  /**
   * Start a device (emulator or simulator)
   * @param device - The device to start
   * @returns Promise with the spawned child process for the running device
   */
  startDevice(
    device: DeviceInfo,
    timeoutMs?: number,
    options?: DeviceStartOptions,
  ): Promise<ChildProcess | null>;

  /**
   * {@link startDevice}, also reporting how the device was obtained, so a caller can tell an
   * emulator it launched or joined from one that is already running elsewhere. Optional: a
   * manager without it is treated as `launched` when it returns a process and `already-running`
   * otherwise.
   */
  startDeviceWithOutcome?(
    device: DeviceInfo,
    timeoutMs?: number,
    options?: DeviceStartOptions,
  ): Promise<DeviceStartResult>;

  /**
   * Kill/terminate a running device
   * @param device - The booted device to kill
   * @returns Promise that resolves when the device has been stopped
   */
  killDevice(device: BootedDevice, options?: DeviceShutdownOptions): Promise<BootedDevice | void>;

  /**
   * Among the given Android serials, which `adb devices` still lists as
   * `offline` rather than absent. An offline emulator is invisible to
   * {@link getBootedDevices} yet its process may still be running, so the
   * shutdown wait uses this to avoid confirming disappearance too early
   * (#10074). Optional: managers without an ADB transport omit it.
   */
  getAndroidOfflineDeviceIds?(
    candidateIds: Iterable<string>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Set<string>>;

  /**
   * Among the given Android serials, every one `adb devices` lists in a
   * non-`device` state (offline, authorizing, unauthorized, ...), keyed to
   * that state (#11090). Optional: managers without an ADB transport omit it.
   */
  getAndroidListedDeviceStates?(
    candidateIds: Iterable<string>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Map<string, string>>;

  /**
   * Delete an already-resolved platform device representation.
   *
   * Android destruction is keyed by the exact AVD name resolved from a booted
   * device. iOS destruction is keyed by the simulator UDID.
   */
  destroyDevice(device: DeviceInfo, options?: DeviceDestroyOptions): Promise<void>;

  /**
   * Wait for a device to be ready for use after starting
   * @param device - The device to wait for
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 120000 = 2 minutes)
   * @param childProcess - Optional child process to monitor for early exit
   * @returns Promise that resolves with the booted device information when device is ready
   */
  waitForDeviceReady(
    device: DeviceInfo,
    timeoutMs?: number,
    childProcess?: ChildProcess | null,
    signal?: AbortSignal,
    options?: AndroidEmulatorReadinessOptions,
  ): Promise<BootedDevice>;
}

/**
 * Wait for a freshly-started device to become ready, actively cancelling the
 * boot if readiness fails (issue #3952).
 *
 * #3951 gave the start handle an honest `kill()` (iOS shuts the simulator down;
 * Android kills the spawned emulator process). This wires that capability into
 * the boot flow: if `waitForDeviceReady` throws — a readiness timeout or
 * failure — the device we just started is torn back down instead of being left
 * booting in the background, where a retry would collide with a half-booted
 * device (`Unable to boot device in current state: Booting`).
 *
 * A `null` handle means we adopted an already-running/already-starting device we
 * did not spawn; there is nothing to kill, so it is left untouched — which is
 * the correct behavior for adopted devices.
 *
 * @param handle - The start handle from `startDevice` (null for adopted devices)
 * @param options - Readiness timeout, cancellation signal, timer and boot-cleanup hooks.
 * @returns The booted device once ready
 * @throws Re-throws the original readiness error after cancelling the boot
 */
export async function waitForDeviceReadyOrCancel(
  deviceManager: PlatformDeviceManager,
  device: DeviceInfo,
  handle: ChildProcess | null,
  options: WaitForDeviceReadyOrCancelOptions = {},
): Promise<BootedDevice> {
  const {
    timeoutMs = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    signal = getAbortSignal(),
    timer = defaultTimer,
    cancelOwnedBoot,
    createTimeoutError,
    readinessOptions,
  } = options;
  const timeoutError = new ActionableError(
    `Device readiness timed out after ${timeoutMs}ms for ${device.deviceId ?? device.name}`,
  );
  try {
    return await runPhaseWithSettlement(
      {
        timer,
        timeoutMs,
        signal,
        graceMs: READINESS_ABORT_SETTLEMENT_GRACE_MS,
        label: "Device readiness",
        timeoutError: () => createTimeoutError?.() ?? timeoutError,
        explicitAbortError: (reason) => (reason instanceof Error ? reason : timeoutError),
        awaitExternalAbortSettlement: false,
        preferOperationFailureOnTimeout: true,
      },
      (readinessSignal) =>
        runWithAbortSignal(readinessSignal, () =>
          deviceManager.waitForDeviceReady(
            device,
            timeoutMs,
            handle,
            readinessSignal,
            readinessOptions,
          ),
        ),
    );
  } catch (failure) {
    if (handle) {
      logger.warn(
        `[startDevice] readiness failed for ${device.deviceId ?? device.name}; ` +
          `cancelling boot via handle.kill()`,
        failure,
      );
      await (cancelOwnedBoot ?? (() => handle.kill()))();
    }
    throw failure;
  }
}

/** Readiness budget for the shared devicectl sweep; a wedged CoreDevice must not stall callers (#11077, #11122). */
export const PHYSICAL_IOS_SCAN_BUDGET_MS = 3_000;

export function skippedPhysicalIosDiscovery(): {
  devices: BootedDevice[];
  complete: false;
  error?: undefined;
} {
  // Nothing was asked of devicectl: no devices, not authoritative, and no failure to report.
  return { devices: [], complete: false };
}

/**
 * Combine booted simulators with connected physical devices into one iOS device
 * list. Simulator and physical UDID shapes are disjoint, but de-duplicating by
 * deviceId keeps the merge idempotent if a future discovery source overlaps;
 * the simulator entry wins because it carries richer runtime metadata.
 */
export function mergeIosDevices(
  simulators: BootedDevice[],
  physical: BootedDevice[],
): BootedDevice[] {
  const seen = new Set(simulators.map((device) => device.deviceId));
  return [...simulators, ...physical.filter((device) => !seen.has(device.deviceId))];
}

/** The simctl operations the device manager drives; `getSimulatorListingChecked` stays optional. */
export type DeviceManagerSimCtl = Pick<
  SimCtl,
  | "isAvailable"
  | "listSimulatorImages"
  | "getBootedSimulators"
  | "getBootedSimulatorsChecked"
  | "getSimulatorListingChecked"
  | "startSimulator"
  | "deleteSimulator"
  | "killSimulator"
  | "waitForSimulatorReady"
>;
