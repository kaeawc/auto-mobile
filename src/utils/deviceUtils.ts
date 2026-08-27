import { errorMessage } from "./describeUnknownError";
import { ChildProcess } from "child_process";
import { DeviceInfo, ActionableError, SomePlatform, BootedDevice, Platform } from "../models";
import { defaultAdbClientFactory } from "./android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "./android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient } from "./ios-cmdline-tools/SimCtlClient";
import {
  DevicectlDeviceLister,
  type IosPhysicalDeviceLister,
  type PhysicalIosDeviceDiscovery,
} from "./ios-cmdline-tools/DevicectlDeviceLister";
import { isIosPhysicalUdid } from "./ios-cmdline-tools/iosDeviceType";
import type { DiscoverySource } from "./discoverySource";
import { AndroidEmulatorClient } from "./android-cmdline-tools/AndroidEmulatorClient";
import { deleteAvd } from "./android-cmdline-tools/avdmanager";
import { logger } from "./logger";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "./deviceTimeouts";
import { getAbortSignal, runWithAbortSignal } from "./AbortContext";
import { defaultTimer, type Timer } from "./SystemTimer";
import {
  getVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";

export { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "./deviceTimeouts";

const READINESS_ABORT_SETTLEMENT_TURNS = 8;

export type DeviceDiscoveryErrorCode = "unavailable" | "failed";

export interface DeviceDiscoveryError {
  code: DeviceDiscoveryErrorCode;
  message: string;
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
  /** Platform-specific typed failures for incomplete observations. */
  discoveryErrors?: Partial<Record<Platform, DeviceDiscoveryError>>;
}

export interface BootedDeviceDiscoveryOptions {
  /** Bypass Android's short device-list cache to verify ADB transport identity. */
  bypassAndroidDeviceListCache?: boolean;
}

export interface DeviceImageDiscovery {
  devices: DeviceInfo[];
  succeededPlatforms: Set<Platform>;
  /** Platform-specific typed failures for incomplete observations. */
  discoveryErrors?: Partial<Record<Platform, DeviceDiscoveryError>>;
}

export interface DeviceImageDiscoveryOptions {
  /** Bypass simulator inventory caching when durable absence must be proven. */
  bypassIosDeviceListCache?: boolean;
}
/** Bounds and cancels a platform shutdown command. */
export interface DeviceShutdownOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Bounds and cancels a platform representation deletion. */
export interface DeviceDestroyOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Existing teardown lease held by a higher-level orchestrator. */
  lifecycleLease?: VirtualDeviceLifecycleLease;
}

/**
 * Interface for device utility operations
 * Provides platform-agnostic device management for Android emulators and iOS simulators
 */
export interface PlatformDeviceManager {
  /**
   * List all available device images for a specific platform
   * @param platform - Target platform ("android", "ios", or "either" for both)
   * @returns Promise with array of available device information
   */
  listDeviceImages(platform: SomePlatform): Promise<DeviceInfo[]>;

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
  startDevice(device: DeviceInfo, timeoutMs?: number): Promise<ChildProcess | null>;

  /**
   * Kill/terminate a running device
   * @param device - The booted device to kill
   * @returns Promise that resolves when the device has been stopped
   */
  killDevice(device: BootedDevice, options?: DeviceShutdownOptions): Promise<BootedDevice | void>;

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
  ): Promise<BootedDevice>;
}

interface ReadinessSettlement {
  settled: boolean;
  failure?: unknown;
}

async function readinessFailureAfterTimeout(
  controller: AbortController,
  settlement: ReadinessSettlement,
  fallback: unknown,
): Promise<unknown> {
  if (!controller.signal.aborted) {
    return fallback;
  }
  for (let turn = 0; turn < READINESS_ABORT_SETTLEMENT_TURNS && !settlement.settled; turn += 1) {
    await Promise.resolve();
  }
  if (settlement.settled && settlement.failure !== undefined) {
    return settlement.failure;
  }
  return fallback;
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
): Promise<BootedDevice> {
  const timeoutError = new ActionableError(
    `Device readiness timed out after ${timeoutMs}ms for ${device.deviceId ?? device.name}`,
  );
  const controller = new AbortController();
  const readinessSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const settlement: ReadinessSettlement = { settled: false };
  let readinessPromise!: Promise<BootedDevice>;

  try {
    readinessPromise = runWithAbortSignal(readinessSignal, () =>
      deviceManager.waitForDeviceReady(device, timeoutMs, handle, readinessSignal),
    ).then(
      (ready) => {
        settlement.settled = true;
        return ready;
      },
      (error) => {
        settlement.settled = true;
        settlement.failure = error;
        throw error;
      },
    );
    // The deadline race below can settle first when a device manager ignores
    // cancellation. Keep a late device-manager rejection from becoming unhandled.
    void readinessPromise.catch(() => {});
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        reject(readinessSignal.reason instanceof Error ? readinessSignal.reason : timeoutError);
      };
      if (readinessSignal.aborted) {
        abortListener();
        return;
      }
      readinessSignal.addEventListener("abort", abortListener, { once: true });
    });
    timeoutHandle = timer.setTimeout(() => {
      controller.abort(timeoutError);
    }, timeoutMs);
    return await Promise.race([readinessPromise, abortPromise]);
  } catch (error) {
    const failure = await readinessFailureAfterTimeout(controller, settlement, error);
    if (handle) {
      logger.warn(
        `[startDevice] readiness failed for ${device.deviceId ?? device.name}; ` +
          `cancelling boot via handle.kill()`,
        failure,
      );
      await (cancelOwnedBoot ?? (() => handle.kill()))();
    }
    throw failure;
  } finally {
    if (timeoutHandle) {
      timer.clearTimeout(timeoutHandle);
    }
    if (abortListener) {
      readinessSignal.removeEventListener("abort", abortListener);
    }
  }
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
  private emulator: AndroidEmulatorClient;
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
    emulator: AndroidEmulatorClient | null = null,
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

  private async canDiscoverIosLocally(): Promise<boolean> {
    if (process.platform === "darwin") {
      return true;
    }

    try {
      return await this.simctl.isAvailable();
    } catch (error) {
      // simctl.isAvailable() throws on non-macOS hosts/missing Xcode tools; treat as "no local iOS discovery".
      logger.debug(`src/utils/deviceUtils.ts fallback failed: ${error}`, error);
      return false;
    }
  }

  private async listIosDeviceImagesIfAvailable(options: {
    swallowDiscoveryErrors: boolean;
  }): Promise<DeviceInfo[]> {
    if (!(await this.canDiscoverIosLocally())) {
      return [];
    }
    try {
      return await this.simctl.listSimulatorImages();
    } catch (error) {
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
      return { devices: [], complete: false };
    }
  }

  private async getBootedIosDevicesIfAvailable(): Promise<BootedDevice[]> {
    if (!(await this.canDiscoverIosLocally())) {
      return [];
    }
    const simulators = await this.simctl.getBootedSimulators().catch((error: unknown) => {
      logger.debug(`[DeviceManager] booted simulator discovery failed: ${errorMessage(error)}`);
      return [] as BootedDevice[];
    });
    return mergeIosDevices(simulators, (await this.listPhysicalIosDevices()).devices);
  }

  /**
   * List all available device images
   * @returns Promise with array of device image names
   */
  async listDeviceImages(platform: SomePlatform): Promise<DeviceInfo[]> {
    switch (platform) {
      case "android":
        return this.emulator.listAvds();
      case "ios":
        return this.listIosDeviceImagesIfAvailable({ swallowDiscoveryErrors: false });
      case "either":
        const emulators = await this.emulator.listAvds();
        const simulators = await this.listIosDeviceImagesIfAvailable({
          swallowDiscoveryErrors: true,
        });
        return [...emulators, ...simulators];
    }
  }

  /**
   * Check if a specific device image is running
   * @param device - The device info to check
   * @returns Promise with boolean indicating if the device image is running
   */
  async isDeviceImageRunning(device: DeviceInfo): Promise<boolean> {
    switch (device.platform) {
      case "android":
        return this.emulator.isAvdRunning(device.name);
      case "ios":
        if (!(await this.canDiscoverIosLocally())) {
          return false;
        }
        if (device.deviceId) {
          const booted = await this.simctl.getBootedSimulators();
          return booted.some((simulator) => simulator.deviceId === device.deviceId);
        }
        return this.simctl.isSimulatorRunning(device.name);
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
    const discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>> = {};

    if (platform === "android" || platform === "either") {
      try {
        const emulators = await this.emulator.getBootedDevicesChecked(
          false,
          {
            bypassDeviceListCache: options.bypassAndroidDeviceListCache,
          },
          getAbortSignal(),
        );
        devices.push(...emulators);
        succeededPlatforms.add("android");
        succeededSources.add("android");
      } catch (error) {
        logger.warn(
          `[DeviceManager] Android booted-device discovery failed; retaining tracked Android devices: ${error}`,
        );
        discoveryErrors.android = {
          code: "failed",
          message: `Android booted-device discovery failed: ${errorMessage(error)}`,
        };
      }
    }

    if (platform === "ios" || platform === "either") {
      const ios = await this.discoverBootedIosDevices();
      // Physical devices that devicectl confirmed are reported even when
      // simulator discovery failed, and vice versa. `succeededPlatforms.ios`
      // still means "simctl completed" for the platform-level consumers that
      // predate #5683; the per-source set below is what lets a consumer decide
      // an individual device without over-reading either failure.
      devices.push(...ios.devices);
      if (ios.simulatorsSucceeded) {
        succeededPlatforms.add("ios");
        succeededSources.add("ios-simulator");
      }
      if (ios.physicalSucceeded) {
        succeededSources.add("ios-physical");
      }
      if (!ios.simulatorsSucceeded && ios.error) {
        discoveryErrors.ios = ios.error;
      }
    }

    return { devices, succeededPlatforms, succeededSources, discoveryErrors };
  }

  async getDeviceImagesDetailed(
    platform: SomePlatform,
    options: DeviceImageDiscoveryOptions = {},
  ): Promise<DeviceImageDiscovery> {
    const devices: DeviceInfo[] = [];
    const succeededPlatforms = new Set<Platform>();
    const discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>> = {};

    if (platform === "android" || platform === "either") {
      try {
        devices.push(...(await this.emulator.listAvds()));
        succeededPlatforms.add("android");
      } catch (error) {
        logger.warn(`[DeviceManager] Android device inventory failed: ${error}`);
        discoveryErrors.android = {
          code: "failed",
          message: `Android device inventory failed: ${errorMessage(error)}`,
        };
      }
    }

    if (platform === "ios" || platform === "either") {
      if (!(await this.canDiscoverIosLocally())) {
        discoveryErrors.ios = {
          code: "unavailable",
          message: "iOS device inventory is unavailable.",
        };
      } else {
        try {
          devices.push(
            ...(await this.simctl.listSimulatorImages(undefined, {
              bypassCache: options.bypassIosDeviceListCache,
            })),
          );
          succeededPlatforms.add("ios");
        } catch (error) {
          logger.warn(`[DeviceManager] iOS device inventory failed: ${error}`);
          discoveryErrors.ios = {
            code: "failed",
            message: `iOS device inventory failed: ${errorMessage(error)}`,
          };
        }
      }
    }

    return { devices, succeededPlatforms, discoveryErrors };
  }

  private async discoverBootedIosDevices(): Promise<{
    devices: BootedDevice[];
    simulatorsSucceeded: boolean;
    physicalSucceeded: boolean;
    error?: DeviceDiscoveryError;
  }> {
    // iOS tooling that is genuinely unavailable on this host cannot confirm a
    // device is gone, so report it as un-discovered rather than empty. Neither
    // source ran, so neither is authoritative.
    if (!(await this.canDiscoverIosLocally())) {
      return {
        devices: [],
        simulatorsSucceeded: false,
        physicalSucceeded: false,
        error: {
          code: "unavailable",
          message: "iOS booted-device discovery is unavailable.",
        },
      };
    }
    // Physical-device discovery runs regardless of the simulator outcome and
    // cannot fail the sweep: it is best-effort by contract.
    const physical = await this.listPhysicalIosDevices();
    if (!physical.complete) {
      logger.warn(
        "[DeviceManager] iOS physical-device discovery was incomplete; " +
          "reporting last-known physical devices, which cannot prove one disconnected.",
      );
    }
    try {
      const simulators = await this.simctl.getBootedSimulatorsChecked();
      return {
        devices: mergeIosDevices(simulators, physical.devices),
        simulatorsSucceeded: true,
        physicalSucceeded: physical.complete,
      };
    } catch (error) {
      // A failed simctl sweep says nothing about the devicectl half: a physical
      // device it positively observed stays authoritative (#5683).
      logger.warn(
        `[DeviceManager] iOS simulator discovery failed; retaining tracked simulators: ${error}`,
      );
      return {
        devices: physical.devices,
        simulatorsSucceeded: false,
        physicalSucceeded: physical.complete,
        error: {
          code: "failed",
          message: `iOS booted-device discovery failed: ${errorMessage(error)}`,
        },
      };
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
  ): Promise<ChildProcess | null> {
    const isRunning = await this.isDeviceImageRunning(device);
    if (isRunning) {
      throw new ActionableError(`${device.platform} device '${device.name}' is already running`);
    }

    switch (device.platform) {
      case "android":
        return (
          await this.emulator.launchEmulator({
            avdName: device.name,
            deviceId: device.deviceId,
            signal: getAbortSignal(),
          })
        ).process;
      case "ios":
        return this.simctl.startSimulator(device.deviceId ?? device.name, timeoutMs);
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
  ): Promise<BootedDevice> {
    switch (device.platform) {
      case "android":
        return this.emulator.waitForEmulatorReady(
          device.name,
          timeoutMs,
          childProcess,
          device.deviceId,
          signal,
        );
      case "ios":
        // A connected physical device has no simulator lifecycle: `simctl
        // bootstatus` cannot answer for its UDID, and discovery already proved
        // it reachable. Treat successful discovery as readiness rather than
        // shelling out to a tool that would only fail (issue #5620).
        if (device.deviceId && isIosPhysicalUdid(device.deviceId)) {
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
        return this.simctl.waitForSimulatorReady(device.deviceId ?? device.name, timeoutMs, {
          assumeBooted: Boolean(childProcess),
        });
      default:
        throw new ActionableError("Unknown platform");
    }
  }
}
