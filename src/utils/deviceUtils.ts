import { errorMessage } from "./describeUnknownError";
import { ChildProcess } from "child_process";
import { DeviceInfo, ActionableError, SomePlatform, BootedDevice, Platform } from "../models";
import { defaultAdbClientFactory } from "./android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "./android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient } from "./ios-cmdline-tools/SimCtlClient";
import { AndroidEmulatorClient } from "./android-cmdline-tools/AndroidEmulatorClient";
import { logger } from "./logger";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "./deviceTimeouts";
import { getAbortSignal, runWithAbortSignal } from "./AbortContext";
import { defaultTimer, type Timer } from "./SystemTimer";

export { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "./deviceTimeouts";

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
  /** Platform-specific typed failures for incomplete observations. */
  discoveryErrors?: Partial<Record<Platform, DeviceDiscoveryError>>;
}

export interface BootedDeviceDiscoveryOptions {
  /** Bypass Android's short device-list cache to verify ADB transport identity. */
  bypassAndroidDeviceListCache?: boolean;
}

/** Bounds and cancels a platform shutdown command. */
export interface DeviceShutdownOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
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
    options?: BootedDeviceDiscoveryOptions
  ): Promise<BootedDeviceDiscovery>;

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
 * @param cancelOwnedBoot - Optional idempotent cleanup for the owned launch handle
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
  cancelOwnedBoot?: () => void,
): Promise<BootedDevice> {
  const timeoutError = new ActionableError(
    `Device readiness timed out after ${timeoutMs}ms for ${device.deviceId ?? device.name}`,
  );
  const controller = new AbortController();
  const readinessSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  try {
    const readinessPromise = runWithAbortSignal(readinessSignal, () =>
      deviceManager.waitForDeviceReady(device, timeoutMs, handle, readinessSignal),
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
    if (handle) {
      logger.warn(
        `[startDevice] readiness failed for ${device.deviceId ?? device.name}; ` +
        `cancelling boot via handle.kill()`,
        error,
      );
      (cancelOwnedBoot ?? (() => handle.kill()))();
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      timer.clearTimeout(timeoutHandle);
    }
    if (abortListener) {
      readinessSignal.removeEventListener("abort", abortListener);
    }
  }
}

export class MultiPlatformDeviceManager implements PlatformDeviceManager {
  private adb: AdbExecutor;
  private emulator: AndroidEmulatorClient;
  private simctl: SimCtlClient;

  /**
   * Create a PlatformDeviceManager instance
   * @param adb - An instance of AdbExecutor for interacting with Android Debug Bridge
   * @param simctl - An instance of SimCtlClient for interacting with iOS simulator controls
   * @param emulator - An instance of AndroidEmulatorClient for managing Android emulators
   */
  constructor(
    adb: AdbExecutor | null = null,
    simctl: SimCtlClient | null = null,
    emulator: AndroidEmulatorClient | null = null,
  ) {
    this.adb = adb || defaultAdbClientFactory.create(null);
    this.simctl = simctl || new SimCtlClient();
    this.emulator = emulator || new AndroidEmulatorClient();
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

  private async listIosDeviceImagesIfAvailable(options: { swallowDiscoveryErrors: boolean }): Promise<DeviceInfo[]> {
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

  private async getBootedIosDevicesIfAvailable(): Promise<BootedDevice[]> {
    if (!(await this.canDiscoverIosLocally())) {
      return [];
    }
    try {
      return await this.simctl.getBootedSimulators();
    } catch {
      return [];
    }
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
        const simulators = await this.listIosDeviceImagesIfAvailable({ swallowDiscoveryErrors: true });
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
          return booted.some(simulator => simulator.deviceId === device.deviceId);
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
    options: BootedDeviceDiscoveryOptions = {}
  ): Promise<BootedDeviceDiscovery> {
    const devices: BootedDevice[] = [];
    const succeededPlatforms = new Set<Platform>();
    const discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>> = {};

    if (platform === "android" || platform === "either") {
      try {
        const emulators = await this.emulator.getBootedDevicesChecked(false, {
          bypassDeviceListCache: options.bypassAndroidDeviceListCache,
        }, getAbortSignal());
        devices.push(...emulators);
        succeededPlatforms.add("android");
      } catch (error) {
        logger.warn(
          `[DeviceManager] Android booted-device discovery failed; retaining tracked Android devices: ${error}`
        );
        discoveryErrors.android = {
          code: "failed",
          message: `Android booted-device discovery failed: ${errorMessage(error)}`,
        };
      }
    }

    if (platform === "ios" || platform === "either") {
      const ios = await this.discoverBootedIosDevices();
      if (ios.succeeded) {
        devices.push(...ios.devices);
        succeededPlatforms.add("ios");
      } else if (ios.error) {
        discoveryErrors.ios = ios.error;
      }
    }

    return { devices, succeededPlatforms, discoveryErrors };
  }

  private async discoverBootedIosDevices(): Promise<{
    devices: BootedDevice[];
    succeeded: boolean;
    error?: DeviceDiscoveryError;
  }> {
    // iOS tooling that is genuinely unavailable on this host cannot confirm a
    // device is gone, so report it as un-discovered rather than empty.
    if (!(await this.canDiscoverIosLocally())) {
      return {
        devices: [],
        succeeded: false,
        error: {
          code: "unavailable",
          message: "iOS booted-device discovery is unavailable.",
        },
      };
    }
    try {
      const devices = await this.simctl.getBootedSimulatorsChecked();
      return { devices, succeeded: true };
    } catch (error) {
      logger.warn(
        `[DeviceManager] iOS booted-device discovery failed; retaining tracked iOS devices: ${error}`
      );
      return {
        devices: [],
        succeeded: false,
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
      throw new ActionableError(
        `${device.platform} device '${device.name}' is already running`
      );
    }

    switch (device.platform) {
      case "android":
        return (await this.emulator.launchEmulator({
          avdName: device.name,
          deviceId: device.deviceId,
          signal: getAbortSignal(),
        })).process;
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
        return this.simctl.killSimulator(device, options);
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
        // A `childProcess` is only supplied on the cold-boot path, where
        // `startSimulator` has already run `bootstatus -b`. Signal that so the
        // wait doesn't redundantly repeat the full boot-readiness wait; the
        // already-running path (no childProcess) still performs it.
        return this.simctl.waitForSimulatorReady(
          device.deviceId ?? device.name,
          timeoutMs,
          { assumeBooted: Boolean(childProcess) }
        );
      default:
        throw new ActionableError("Unknown platform");
    }
  }
}
