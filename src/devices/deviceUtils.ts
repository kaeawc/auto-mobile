import { AdbCommandTimeoutError } from "../utils/android-cmdline-tools/AdbClient";
import { errorMessage } from "../utils/describeUnknownError";
import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
export type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import { DeviceInfo, ActionableError, SomePlatform, BootedDevice, Platform } from "../models";
import { toActionableError } from "../models/ActionableError";
import { DeviceAlreadyRunningError } from "../models/DeviceAlreadyRunningError";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import {
  DevicectlDeviceLister,
  type IosPhysicalDeviceLister,
  type PhysicalIosDeviceDiscovery,
} from "../utils/ios-cmdline-tools/DevicectlDeviceLister";
import { isIosPhysicalUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import type { DiscoverySource } from "../utils/discoverySource";
import { AndroidEmulatorClient } from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import type {
  AndroidEmulatorForDeviceManager,
  AndroidEmulatorReadinessOptions,
} from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import { deleteAvd } from "../utils/android-cmdline-tools/avdmanager";
import { logger } from "../utils/logger";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { isUnresolvedAndroidEmulatorName } from "./deviceIdentityEvidence";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { combineWithAmbientAbort, getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { runPhaseWithSettlement } from "../utils/runPhaseWithSettlement";
import {
  getVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";

export { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";

// Pool allocation deadlines must not advance while a non-cooperative readiness wait settles.
// A bounded microtask wait lets cooperative promise rejections surface before cleanup.
const READINESS_ABORT_SETTLEMENT_GRACE_MS = 0;

/**
 * A configured Android image with incomplete ADB liveness must not be used for
 * a cold boot: it may already be running behind the unavailable overlay.
 */
export function assertAndroidImageRunningStateKnown(image: DeviceInfo): void {
  if (image.platform === "android" && image.isRunningStateKnown === false) {
    throw new ActionableError(
      `Cannot safely cold-boot Android AVD '${image.name}': its running state is unknown.`,
    );
  }
}

export type DeviceDiscoveryErrorCode = "unavailable" | "failed" | "timeout";

export interface DeviceDiscoveryError {
  code: DeviceDiscoveryErrorCode;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
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
}

/** The iOS sources that completed, from one sweep's per-source outcome. */
function iosSucceededSources(outcome: {
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
  /** Bypass Android's short device-list cache to verify ADB transport identity. */
  bypassAndroidDeviceListCache?: boolean;
  /** Bypass iOS's short simulator-list cache to verify simulator identity. */
  bypassIosDeviceListCache?: boolean;
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
}

export interface DeviceImageDiscovery {
  devices: DeviceInfo[];
  succeededPlatforms: Set<Platform>;
  /** Platform-specific typed failures for incomplete observations. */
  discoveryErrors?: Partial<Record<Platform, DeviceDiscoveryError>>;
}

function presentBootedDevices(
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
 * @param deviceManager - The platform device manager performing the readiness wait
 * @param device - The device that was started
 * @param handle - The start handle from `startDevice` (null for adopted devices)
 * @param timeoutMs - Optional readiness timeout
 * @param signal - Optional cancellation signal for a non-cooperative readiness wait
 * @param cancelOwnedBoot - Optional idempotent cleanup for the owned launch handle.
 *   Async cleanup is awaited so lifecycle owners can retain their lease until
 *   the launch process settles.
 * @returns The booted device once ready
 * @throws Re-throws the original readiness error after cancelling the boot
 */
export async function waitForDeviceReadyOrCancel(
  deviceManager: PlatformDeviceManager,
  device: DeviceInfo,
  handle: ChildProcess | null,
  timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  signal: AbortSignal | undefined = getAbortSignal(),
  timer: Pick<Timer, "setTimeout" | "clearTimeout"> = defaultTimer,
  cancelOwnedBoot?: () => void | Promise<void>,
  createTimeoutError?: () => Error,
  readinessOptions?: AndroidEmulatorReadinessOptions,
): Promise<BootedDevice> {
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

function skippedPhysicalIosDiscovery(): {
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
function mergeIosDevices(simulators: BootedDevice[], physical: BootedDevice[]): BootedDevice[] {
  const seen = new Set(simulators.map((device) => device.deviceId));
  return [...simulators, ...physical.filter((device) => !seen.has(device.deviceId))];
}

export class MultiPlatformDeviceManager implements PlatformDeviceManager {
  private adb: AdbExecutor;
  private emulator: AndroidEmulatorForDeviceManager;
  private simctl: SimCtlClient;
  private readonly physicalIosDevices: IosPhysicalDeviceLister;
  private readonly lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;
  private readonly timer: Pick<Timer, "now">;

  /**
   * Create a PlatformDeviceManager instance
   * @param adb - An instance of AdbExecutor for interacting with Android Debug Bridge
   * @param simctl - An instance of SimCtlClient for interacting with iOS simulator controls
   * @param emulator - An instance of AndroidEmulatorClient for managing Android emulators
   * @param physicalIosDevices - Discovery seam for connected physical iOS devices (devicectl)
   */
  constructor(
    adb: AdbExecutor | null = null,
    simctl: SimCtlClient | null = null,
    emulator: AndroidEmulatorForDeviceManager | null = null,
    lifecycleCoordinator: VirtualDeviceLifecycleCoordinator = getVirtualDeviceLifecycleCoordinator(),
    timer: Pick<Timer, "now"> = defaultTimer,
    physicalIosDevices: IosPhysicalDeviceLister | null = null,
  ) {
    this.adb = adb || defaultAdbClientFactory.create(null);
    this.simctl = simctl || new SimCtlClient();
    this.emulator = emulator || new AndroidEmulatorClient();
    this.physicalIosDevices = physicalIosDevices || new DevicectlDeviceLister();
    this.lifecycleCoordinator = lifecycleCoordinator;
    this.timer = timer;
  }

  private async canDiscoverIosLocally(signal?: AbortSignal): Promise<boolean> {
    const discoverySignal = combineWithAmbientAbort(signal);
    discoverySignal?.throwIfAborted();
    if (process.platform === "darwin") {
      return true;
    }

    try {
      const available = await this.simctl.isAvailable({ signal: discoverySignal });
      discoverySignal?.throwIfAborted();
      return available;
    } catch (error) {
      discoverySignal?.throwIfAborted();
      // simctl.isAvailable() throws on non-macOS hosts/missing Xcode tools; treat as "no local iOS discovery".
      logger.debug(`src/utils/deviceUtils.ts fallback failed: ${error}`, error);
      return false;
    }
  }

  private async listIosDeviceImagesIfAvailable(options: {
    swallowDiscoveryErrors: boolean;
    signal?: AbortSignal;
  }): Promise<DeviceInfo[]> {
    if (!(await this.canDiscoverIosLocally(options.signal))) {
      return [];
    }
    const discoverySignal = combineWithAmbientAbort(options.signal);
    try {
      return await this.simctl.listSimulatorImages(undefined, { signal: discoverySignal });
    } catch (error) {
      discoverySignal?.throwIfAborted();
      logger.warn(`[DeviceManager] iOS simulator image discovery failed: ${error}`);
      if (!options.swallowDiscoveryErrors) {
        throw error;
      }
      return [];
    }
  }

  /**
   * Connected physical iOS devices, or an empty list when devicectl cannot
   * answer. Additive to simulator discovery and never throws, so a host with no
   * Xcode/hardware still resolves its simulators (issue #5620).
   */
  private async listPhysicalIosDevices(): Promise<PhysicalIosDeviceDiscovery> {
    try {
      return await this.physicalIosDevices.listConnectedDevices();
    } catch (error) {
      // The lister contract is non-throwing; a misbehaving implementation must
      // still not take simulator discovery down with it. `complete: false` so a
      // devicectl blip cannot be read as "the physical device disconnected".
      logger.warn(`[DeviceManager] physical iOS device discovery failed: ${errorMessage(error)}`);
      return {
        devices: [],
        complete: false,
        error: {
          code: "failed",
          message: `devicectl could not list physical iOS devices (failed): ${errorMessage(error).split(/\r?\n/, 1)[0]}`,
        },
      };
    }
  }

  private async getBootedIosDevicesIfAvailable(): Promise<BootedDevice[]> {
    if (!(await this.canDiscoverIosLocally())) {
      return [];
    }
    const simulators = await this.simctl.getBootedSimulators().catch((error: unknown) => {
      logger.warn(`[DeviceManager] booted simulator discovery failed: ${errorMessage(error)}`);
      return [] as BootedDevice[];
    });
    return mergeIosDevices(simulators, (await this.listPhysicalIosDevices()).devices);
  }

  /**
   * List all available device images
   * @returns Promise with array of device image names
   */
  async listDeviceImages(platform: SomePlatform, signal?: AbortSignal): Promise<DeviceInfo[]> {
    switch (platform) {
      case "android":
        return this.listAndroidDeviceImages({ signal });
      case "ios":
        return this.listIosDeviceImagesIfAvailable({ swallowDiscoveryErrors: false, signal });
      case "either":
        const emulators = await this.listAndroidDeviceImages({ signal });
        const simulators = await this.listIosDeviceImagesIfAvailable({
          swallowDiscoveryErrors: true,
          signal,
        });
        return [...emulators, ...simulators];
    }
  }

  /**
   * List Android AVD images with live isRunning state. `listAvds` reports every
   * AVD as isRunning:false; the iOS listing already reports its booted state
   * from simctl, so this overlays the booted-emulator scan to keep the two
   * platforms' image listings symmetric (issue #6850). The booted-device scan
   * shares the caller's cancellation signal so an expired resource request does
   * not leave ADB discovery and AVD-name enrichment running in the background.
   *
   * Only `emulator-<port>` serials may contribute to the overlay: the booted
   * scan also reports physical handsets, whose `name` is ro.product.model, and
   * a handset modelled like an AVD would otherwise mark that AVD running and
   * let bootMatchedImage() hand back the handset instead of booting the AVD.
   */
  private async listAndroidDeviceImages(
    options: DeviceImageDiscoveryOptions = {},
  ): Promise<DeviceInfo[]> {
    const bootedDeviceSignal = combineWithAmbientAbort(options.signal);
    const [images, overlay] = await Promise.all([
      this.emulator.listAvds({
        signal: bootedDeviceSignal,
        coalesceInventoryEnrichment: options.coalesceInventoryEnrichment,
      }),
      this.getAndroidRunningStateOverlay({ ...options, signal: bootedDeviceSignal }),
    ]);
    return images.map((image) => ({
      ...image,
      isRunning: overlay?.runningAvdNames.has(image.name) ?? false,
      ...(overlay === undefined ||
      (overlay.hasUnresolvedEmulatorIdentity && !overlay.runningAvdNames.has(image.name))
        ? { isRunningStateKnown: false }
        : {}),
    }));
  }

  /**
   * Fetch and derive the booted-emulator running-state overlay. Any
   * non-cancellation failure is isolated here so configured AVD discovery can
   * still return its complete inventory (issue #7169).
   */
  private async getAndroidRunningStateOverlay(
    options: DeviceImageDiscoveryOptions = {},
  ): Promise<{ runningAvdNames: Set<string>; hasUnresolvedEmulatorIdentity: boolean } | undefined> {
    try {
      const bootedDevices = await this.emulator.getBootedDevicesChecked(
        false,
        { readinessOnly: true, coalesceInventoryEnrichment: options.coalesceInventoryEnrichment },
        options.signal,
      );
      const emulatorDevices = bootedDevices.filter((device) =>
        isAndroidEmulatorSerial(device.deviceId),
      );
      return {
        runningAvdNames: new Set(emulatorDevices.map((device) => device.name)),
        hasUnresolvedEmulatorIdentity: emulatorDevices.some(isUnresolvedAndroidEmulatorName),
      };
    } catch (error) {
      options.signal?.throwIfAborted();
      logger.warn(`[DeviceManager] Android running-state overlay failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Check if a specific device image is running
   * @param device - The device info to check
   * @returns Promise with boolean indicating if the device image is running
   */
  async isDeviceImageRunning(device: DeviceInfo): Promise<boolean> {
    switch (device.platform) {
      case "android": {
        const booted = await this.emulator.getBootedDevicesChecked(false, {
          bypassDeviceListCache: true,
        });
        return booted.some((emulator) => emulator.name === device.name);
      }
      case "ios":
        if (!(await this.canDiscoverIosLocally())) {
          return false;
        }
        return (
          await this.simctl.getBootedSimulatorsChecked(undefined, undefined, {
            bypassCache: true,
          })
        ).some(
          (simulator) =>
            simulator.deviceId === device.deviceId ||
            (device.deviceId === undefined && simulator.name === device.name),
        );
    }
  }

  /**
   * Check if any device is currently running
   * @returns Promise with array of running device info
   */
  async getBootedDevices(platform: SomePlatform): Promise<BootedDevice[]> {
    switch (platform) {
      case "android":
        return this.emulator.getBootedDevices();
      case "ios":
        return this.getBootedIosDevicesIfAvailable();
      case "either":
        const emulators = await this.emulator.getBootedDevices();
        const simulators = await this.getBootedIosDevicesIfAvailable();
        return [...emulators, ...simulators];
    }
  }

  async getBootedDevicesDetailed(
    platform: SomePlatform,
    options: BootedDeviceDiscoveryOptions = {},
  ): Promise<BootedDeviceDiscovery> {
    const devices: BootedDevice[] = [];
    const succeededPlatforms = new Set<Platform>();
    const succeededSources = new Set<DiscoverySource>();
    const freshDeviceIds = new Set<string>();
    const sourceErrors: Partial<Record<DiscoverySource, DeviceDiscoveryError>> = {};
    const discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>> = {};

    const [android, ios] = await Promise.all([
      platform === "android" || platform === "either"
        ? this.discoverBootedAndroidDevices(options)
        : undefined,
      platform === "ios" || platform === "either"
        ? this.discoverBootedIosDevices(options)
        : undefined,
    ]);

    if (android) {
      this.appendAndroidBootedDiscovery(android, {
        devices,
        succeededPlatforms,
        succeededSources,
        freshDeviceIds,
        discoveryErrors,
        sourceErrors,
      });
    }

    if (ios) {
      this.appendIosBootedDiscovery(ios, {
        devices,
        succeededPlatforms,
        succeededSources,
        freshDeviceIds,
        discoveryErrors,
        sourceErrors,
      });
    }

    return {
      devices: presentBootedDevices(devices, options.presentationOrder),
      succeededPlatforms,
      succeededSources,
      freshDeviceIds,
      discoveryErrors,
      ...(Object.keys(sourceErrors).length > 0 ? { sourceErrors } : {}),
    };
  }

  private appendAndroidBootedDiscovery(
    android: { devices: BootedDevice[]; error?: DeviceDiscoveryError },
    result: BootedDeviceDiscovery & {
      succeededSources: Set<DiscoverySource>;
      freshDeviceIds: Set<string>;
      discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>>;
    },
  ): void {
    result.devices.push(...android.devices);
    if (android.error) {
      result.discoveryErrors.android = android.error;
      return;
    }
    result.succeededPlatforms.add("android");
    result.succeededSources.add("android");
    // adb has no retention replay: a listed device was listed just now.
    for (const emulator of android.devices) {
      result.freshDeviceIds.add(emulator.deviceId);
    }
  }

  private appendIosBootedDiscovery(
    ios: Awaited<ReturnType<MultiPlatformDeviceManager["discoverBootedIosDevices"]>>,
    result: BootedDeviceDiscovery & {
      succeededSources: Set<DiscoverySource>;
      freshDeviceIds: Set<string>;
      sourceErrors: Partial<Record<DiscoverySource, DeviceDiscoveryError>>;
      discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>>;
    },
  ): void {
    if (ios.physicalError) {
      result.sourceErrors["ios-physical"] = ios.physicalError;
    }
    // Physical devices confirmed by devicectl survive simulator discovery failure.
    result.devices.push(...ios.devices);
    for (const source of iosSucceededSources(ios)) {
      result.succeededSources.add(source);
    }
    if (ios.simulatorsSucceeded) {
      result.succeededPlatforms.add("ios");
    } else if (ios.error) {
      result.discoveryErrors.ios = ios.error;
    }
    for (const deviceId of ios.freshDeviceIds) {
      result.freshDeviceIds.add(deviceId);
    }
  }

  /**
   * Among the given Android candidate serials, which are ADB `offline`
   * rather than absent. Android-only: iOS's `simctl` has no analogous
   * transport state (#7536). Best-effort — see
   * {@link AndroidEmulatorClient.getOfflineDeviceIdsAmong}.
   */
  async getAndroidOfflineDeviceIds(
    candidateIds: Iterable<string>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Set<string>> {
    return this.emulator.getOfflineDeviceIdsAmong(candidateIds, options);
  }

  /**
   * Best-effort `adb reconnect offline` for session-bound Android serial(s)
   * seen stuck in ADB `offline`. See
   * {@link AndroidEmulatorClient.recoverOfflineDevices}.
   */
  async recoverAndroidOfflineDevices(
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.emulator.recoverOfflineDevices(options);
  }

  async getDeviceImagesDetailed(
    platform: SomePlatform,
    options: DeviceImageDiscoveryOptions = {},
  ): Promise<DeviceImageDiscovery> {
    const devices: DeviceInfo[] = [];
    const succeededPlatforms = new Set<Platform>();
    const discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>> = {};

    const [android, ios] = await Promise.all([
      platform === "android" || platform === "either"
        ? this.discoverAndroidDeviceImages(options)
        : undefined,
      platform === "ios" || platform === "either"
        ? this.discoverIosDeviceImages(options)
        : undefined,
    ]);

    if (android) {
      devices.push(...android.devices);
      if (android.error) {
        discoveryErrors.android = android.error;
      }
      if (android.succeeded) {
        succeededPlatforms.add("android");
      }
    }

    if (ios) {
      devices.push(...ios.devices);
      if (ios.error) {
        discoveryErrors.ios = ios.error;
      }
      if (ios.succeeded) {
        succeededPlatforms.add("ios");
      }
    }

    return { devices, succeededPlatforms, discoveryErrors };
  }

  private async discoverAndroidDeviceImages(options: DeviceImageDiscoveryOptions): Promise<{
    devices: DeviceInfo[];
    succeeded: boolean;
    error?: DeviceDiscoveryError;
  }> {
    try {
      return { devices: await this.listAndroidDeviceImages(options), succeeded: true };
    } catch (error) {
      logger.warn(`[DeviceManager] Android device inventory failed: ${error}`);
      return {
        devices: [],
        succeeded: false,
        error: {
          code: "failed",
          message: `Android device inventory failed: ${errorMessage(error)}`,
        },
      };
    }
  }

  private async discoverIosDeviceImages(options: DeviceImageDiscoveryOptions): Promise<{
    devices: DeviceInfo[];
    succeeded: boolean;
    error?: DeviceDiscoveryError;
  }> {
    if (!(await this.canDiscoverIosLocally(options.signal))) {
      return {
        devices: [],
        succeeded: false,
        error: { code: "unavailable", message: "iOS device inventory is unavailable." },
      };
    }
    try {
      return {
        devices: await this.simctl.listSimulatorImages(undefined, {
          bypassCache: options.bypassIosDeviceListCache,
          signal: combineWithAmbientAbort(options.signal),
        }),
        succeeded: true,
      };
    } catch (error) {
      logger.warn(`[DeviceManager] iOS device inventory failed: ${error}`);
      return {
        devices: [],
        succeeded: false,
        error: {
          code: "failed",
          message: `iOS device inventory failed: ${errorMessage(error)}`,
        },
      };
    }
  }

  private async discoverBootedAndroidDevices(
    options: BootedDeviceDiscoveryOptions,
  ): Promise<{ devices: BootedDevice[]; error?: DeviceDiscoveryError }> {
    const signal = combineWithAmbientAbort(options.signal);
    try {
      return {
        devices: await this.emulator.getBootedDevicesChecked(
          false,
          {
            coalesceInventoryEnrichment: options.coalesceInventoryEnrichment,
            bypassDeviceListCache: options.bypassAndroidDeviceListCache,
            skipNameEnrichment: options.skipAndroidNameEnrichment,
          },
          signal,
        ),
      };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[DeviceManager] Android booted-device discovery failed; retaining tracked Android devices: ${error}`,
      );
      return {
        devices: [],
        error: {
          code: error instanceof AdbCommandTimeoutError ? "timeout" : "failed",
          message: `Android booted-device discovery failed: ${errorMessage(error)}`,
          ...(error instanceof AdbCommandTimeoutError
            ? { retryable: true, retryAfterMs: 1_000 }
            : {}),
        },
      };
    }
  }

  private async discoverPhysicalIosDevices(
    signal: AbortSignal | undefined,
  ): Promise<PhysicalIosDeviceDiscovery> {
    // Physical-device discovery runs regardless of the simulator outcome and
    // cannot fail the sweep: it is best-effort by contract.
    const physical = await raceWithDeadline(this.listPhysicalIosDevices(), {
      timer: defaultTimer,
      signal,
      label: "iOS physical-device discovery",
      relabelDefaultAbort: false,
    });
    if (!physical.complete) {
      logger.debug(
        "[DeviceManager] iOS physical-device discovery was incomplete; " +
          "reporting last-known physical devices, which cannot prove one disconnected.",
      );
    }
    return physical;
  }

  private async discoverBootedIosDevices(options: BootedDeviceDiscoveryOptions): Promise<{
    devices: BootedDevice[];
    simulatorsSucceeded: boolean;
    physicalSucceeded: boolean;
    /** Ids observed by this sweep, excluding devicectl's retained replay. */
    freshDeviceIds: Set<string>;
    error?: DeviceDiscoveryError;
    physicalError?: DeviceDiscoveryError;
  }> {
    const signal = combineWithAmbientAbort(options.signal);
    signal?.throwIfAborted();
    // iOS tooling that is genuinely unavailable on this host cannot confirm a
    // device is gone, so report it as un-discovered rather than empty. Neither
    // source ran, so neither is authoritative.
    if (!(await this.canDiscoverIosLocally(signal))) {
      return {
        devices: [],
        simulatorsSucceeded: false,
        physicalSucceeded: false,
        freshDeviceIds: new Set(),
        error: {
          code: "unavailable",
          message: "iOS booted-device discovery is unavailable.",
        },
      };
    }
    // Physical-device discovery runs regardless of the simulator outcome and
    // cannot fail the sweep: it is best-effort by contract.
    const physical = options.skipPhysicalIosDiscovery
      ? skippedPhysicalIosDiscovery()
      : await this.discoverPhysicalIosDevices(signal);
    const freshPhysicalIds = physical.complete
      ? physical.devices.map((device) => device.deviceId)
      : [];
    const physicalError = physical.complete ? undefined : physical.error;
    try {
      const simulators = await this.simctl.getBootedSimulatorsChecked(undefined, signal, {
        bypassCache: options.bypassIosDeviceListCache,
      });
      return {
        devices: mergeIosDevices(simulators, physical.devices),
        simulatorsSucceeded: true,
        physicalSucceeded: physical.complete,
        ...(physicalError ? { physicalError } : {}),
        freshDeviceIds: new Set([
          ...simulators.map((device) => device.deviceId),
          ...freshPhysicalIds,
        ]),
      };
    } catch (error) {
      signal?.throwIfAborted();
      // A failed simctl sweep says nothing about the devicectl half: a physical
      // device it positively observed stays authoritative (#5683).
      logger.warn(
        `[DeviceManager] iOS simulator discovery failed; retaining tracked simulators: ${error}`,
      );
      return {
        devices: physical.devices,
        simulatorsSucceeded: false,
        physicalSucceeded: physical.complete,
        ...(physicalError ? { physicalError } : {}),
        freshDeviceIds: new Set(freshPhysicalIds),
        error: {
          code: "failed",
          message: `iOS booted-device discovery failed: ${errorMessage(error)}`,
        },
      };
    }
  }

  private validateCameraPosterTarget(device: DeviceInfo, options: DeviceStartOptions): void {
    if (options.cameraPosterPath !== undefined && device.platform !== "android") {
      throw new ActionableError(
        "cameraPosterPath is unsupported on iOS. Use a stopped Android emulator.",
      );
    }
    if (
      options.cameraPosterPath !== undefined &&
      device.deviceId &&
      !isAndroidEmulatorSerial(device.deviceId)
    ) {
      throw new ActionableError(
        "cameraPosterPath is unsupported on physical Android devices. Use a stopped Android emulator.",
      );
    }
  }

  /**
   * Start a device
   * @param device - The device to start
   * @returns Promise with the spawned child process
   */
  async startDevice(
    device: DeviceInfo,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    options: DeviceStartOptions = {},
  ): Promise<ChildProcess | null> {
    this.validateCameraPosterTarget(device, options);
    assertAndroidImageRunningStateKnown(device);
    // Validate the UDID before any simctl running-state probe: a slow/hung
    // 'simctl list' would otherwise burn the boot budget, and an already-booted
    // same-named simulator would make isDeviceImageRunning() return true and
    // mask this guard behind an "already running" error (#6414).
    if (device.platform === "ios" && !device.deviceId) {
      throw new ActionableError(
        `Cannot boot iOS simulator '${device.name}' without a simulator UDID: ` +
          `a name-only target cannot be verified against 'simctl' state after boot`,
      );
    }

    let isRunning: boolean;
    try {
      isRunning = await this.isDeviceImageRunning(device);
    } catch (error) {
      throw toActionableError(
        error,
        `Failed to determine whether ${device.platform} device '${device.name}' is already running`,
      );
    }
    if (isRunning) {
      if (options.cameraPosterPath !== undefined) {
        throw new ActionableError(
          "cameraPosterPath is unsupported on a running Android emulator. Stop it first.",
        );
      }
      throw new DeviceAlreadyRunningError(
        `${device.platform} device '${device.name}' is already running`,
        device.platform,
        device.deviceId,
      );
    }

    switch (device.platform) {
      case "android":
        return (
          await this.emulator.launchEmulator({
            avdName: device.name,
            deviceId: device.deviceId,
            signal: getAbortSignal(),
            cameraPosterPath: options.cameraPosterPath,
          })
        ).process;
      case "ios":
        if (!device.deviceId) {
          throw new ActionableError(
            `Cannot boot iOS simulator '${device.name}' without a simulator UDID: ` +
              `a name-only target cannot be verified against 'simctl' state after boot`,
          );
        }
        return this.simctl.startSimulator(device.deviceId, timeoutMs);
      default:
        throw new ActionableError("Unknown platform");
    }
  }

  /**
   * Kill a running device
   * @param device - The device to kill
   * @returns Promise that resolves when device is stopped
   */
  async killDevice(
    device: BootedDevice,
    options?: DeviceShutdownOptions,
  ): Promise<BootedDevice | void> {
    switch (device.platform) {
      case "android":
        return this.emulator.killDevice(device, options);
      case "ios":
        // Physical devices are discoverable now (issue #5620), so a kill request
        // can reach one. `simctl shutdown` cannot act on a physical UDID — it
        // would fail with an opaque CoreSimulator error — and there is no
        // devicectl equivalent of shutting a device down, so say so plainly.
        if (device.deviceId && isIosPhysicalUdid(device.deviceId)) {
          throw new ActionableError(
            `Cannot shut down physical iOS device ${device.deviceId}: only simulators have a ` +
              `remote shutdown path. Disconnect or power the device off manually.`,
          );
        }
        return this.simctl.killSimulator(device, options);
    }
  }

  async destroyDevice(device: DeviceInfo, options?: DeviceDestroyOptions): Promise<void> {
    const ownLease = options?.lifecycleLease === undefined;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
    const lifecycleLease =
      options?.lifecycleLease ??
      (await this.lifecycleCoordinator.reserve(
        {
          kind: "stable",
          platform: device.platform,
          stableId: device.platform === "android" ? device.name : (device.deviceId ?? device.name),
        },
        {
          operation: "teardown",
          deadlineMs: this.timer.now() + timeoutMs,
          signal: options?.signal,
        },
      ));
    const signals = [options?.signal, lifecycleLease.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    try {
      await runWithAbortSignal(
        signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        async () =>
          await this.destroyDeviceRepresentation(device, {
            timeoutMs,
            signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
          }),
      );
    } finally {
      if (ownLease) {
        lifecycleLease.release();
      }
    }
  }

  private async destroyDeviceRepresentation(
    device: DeviceInfo,
    options: DeviceDestroyOptions,
  ): Promise<void> {
    switch (device.platform) {
      case "android": {
        const result = await deleteAvd(device.name, undefined, {
          signal: options?.signal,
          timeoutMs: options?.timeoutMs,
        });
        if (!result.success) {
          throw new ActionableError(result.message);
        }
        return;
      }
      case "ios":
        if (!device.deviceId) {
          throw new ActionableError(
            `Cannot delete iOS simulator '${device.name}' without a simulator UDID`,
          );
        }
        await this.simctl.deleteSimulator(device.deviceId, options);
        return;
    }
  }

  /**
   * Wait for the device to be ready for use
   * @param device - The device to wait for
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 120000 = 2 minutes)
   * @returns Promise that resolves with device ID when device is ready
   */
  async waitForDeviceReady(
    device: DeviceInfo,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    childProcess?: ChildProcess | null,
    signal?: AbortSignal,
    options?: AndroidEmulatorReadinessOptions,
  ): Promise<BootedDevice> {
    switch (device.platform) {
      case "android":
        return this.emulator.waitForEmulatorReady(
          device.name,
          timeoutMs,
          childProcess,
          device.deviceId,
          signal,
          options,
        );
      case "ios":
        if (!device.deviceId) {
          throw new ActionableError(
            `Cannot wait for iOS simulator '${device.name}' without a simulator UDID: ` +
              `a name-only target cannot be verified against 'simctl' state after boot`,
          );
        }
        // A connected physical device has no simulator lifecycle: `simctl
        // bootstatus` cannot answer for its UDID, and discovery already proved
        // it reachable. Treat successful discovery as readiness rather than
        // shelling out to a tool that would only fail (issue #5620).
        if (isIosPhysicalUdid(device.deviceId)) {
          return {
            name: device.name,
            platform: "ios",
            deviceId: device.deviceId,
            ...(device.iosVersion ? { iosVersion: device.iosVersion } : {}),
            ...(device.osVersion ? { osVersion: device.osVersion } : {}),
            ...(device.formFactor ? { formFactor: device.formFactor } : {}),
          };
        }
        // A `childProcess` is only supplied on the cold-boot path, where
        // `startSimulator` has already run `bootstatus -b`. Signal that so the
        // wait doesn't redundantly repeat the full boot-readiness wait; the
        // already-running path (no childProcess) still performs it.
        return this.simctl.waitForSimulatorReady(device.deviceId, timeoutMs, {
          assumeBooted: Boolean(childProcess),
        });
      default:
        throw new ActionableError("Unknown platform");
    }
  }
}
