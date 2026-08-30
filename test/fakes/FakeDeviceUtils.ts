import { ChildProcess } from "child_process";
import { BootedDevice, DeviceInfo, SomePlatform, Platform } from "../../src/models";
import {
  BootedDeviceDiscovery,
  DeviceDestroyOptions,
  DeviceImageDiscovery,
  PlatformDeviceManager,
} from "../../src/utils/deviceUtils";
import { type DiscoverySource, sourcesForPlatform } from "../../src/utils/discoverySource";

/**
 * Fake implementation of PlatformDeviceManager for testing
 * Allows configuring device states and asserting operations
 */
export class FakeDeviceUtils implements PlatformDeviceManager {
  private deviceImages: Map<Platform, DeviceInfo[]> = new Map();
  private bootedDevices: Map<Platform, BootedDevice[]> = new Map();
  private runningDeviceNames: Set<string> = new Set();
  private executedOperations: string[] = [];
  private mockChildProcesses: Map<string, ChildProcess | null> = new Map();
  private waitForDeviceReadyChildProcess: ChildProcess | null | undefined;
  private waitForDeviceReadySignal: AbortSignal | undefined;
  private waitForDeviceReadyError: Error | undefined;

  /**
   * Configure available device images for a platform
   * @param platform - The platform to configure
   * @param devices - Array of device images to make available
   */
  setDeviceImages(platform: Platform, devices: DeviceInfo[]): void {
    this.deviceImages.set(platform, devices);
  }

  /**
   * Configure booted devices for a platform
   * @param platform - The platform to configure
   * @param devices - Array of booted devices
   */
  setBootedDevices(platform: Platform, devices: BootedDevice[]): void {
    this.bootedDevices.set(platform, devices);
    // Track running device names
    devices.forEach((device) => {
      this.runningDeviceNames.add(device.name);
      this.runningDeviceNames.add(device.deviceId);
    });
  }

  /**
   * Add a single booted device to the platform
   * @param device - The booted device to add
   */
  addBootedDevice(device: BootedDevice): void {
    const platform = device.platform;
    const existing = this.bootedDevices.get(platform) || [];
    this.bootedDevices.set(platform, [...existing, device]);
    this.runningDeviceNames.add(device.name);
    this.runningDeviceNames.add(device.deviceId);
  }

  /**
   * Mark a device as running
   * @param deviceName - The name of the device
   */
  markDeviceAsRunning(deviceName: string): void {
    this.runningDeviceNames.add(deviceName);
  }

  /**
   * Mark a device as not running
   * @param deviceName - The name of the device
   */
  markDeviceAsStopped(deviceName: string): void {
    this.runningDeviceNames.delete(deviceName);
  }

  /**
   * Set a mock ChildProcess to be returned for a specific device
   * @param deviceName - The device name
   * @param childProcess - The mock child process to return
   */
  setMockChildProcess(deviceName: string, childProcess: ChildProcess | null): void {
    this.mockChildProcesses.set(deviceName, childProcess);
  }

  /**
   * Get history of executed operations (for test assertions)
   * @returns Array of operation strings that were executed
   */
  getExecutedOperations(): string[] {
    return [...this.executedOperations];
  }

  getWaitForDeviceReadyChildProcess(): ChildProcess | null | undefined {
    return this.waitForDeviceReadyChildProcess;
  }

  getWaitForDeviceReadySignal(): AbortSignal | undefined {
    return this.waitForDeviceReadySignal;
  }

  /**
   * Configure waitForDeviceReady to reject, simulating a readiness
   * timeout/failure (issue #3952 cancel-on-failure path).
   * @param error - The error to throw, or undefined to resolve normally
   */
  setWaitForDeviceReadyError(error: Error | undefined): void {
    this.waitForDeviceReadyError = error;
  }

  /**
   * Check if a specific method was called
   * @param operationName - Name of the operation to check (e.g., "listDeviceImages", "startDevice")
   * @returns true if the operation was called at least once
   */
  wasMethodCalled(operationName: string): boolean {
    return this.executedOperations.some((op) => op.includes(operationName));
  }

  /**
   * Get count of times a specific method was called
   * @param operationName - Name of the operation to count
   * @returns Number of times the operation was called
   */
  getCallCount(operationName: string): number {
    return this.executedOperations.filter((op) => op.includes(operationName)).length;
  }

  /**
   * Clear operation history
   */
  clearHistory(): void {
    this.executedOperations = [];
  }

  // Implementation of DeviceUtils interface

  async listDeviceImages(platform: SomePlatform): Promise<DeviceInfo[]> {
    this.executedOperations.push(`listDeviceImages:${platform}`);

    if (platform === "either") {
      const androidDevices = this.deviceImages.get("android") || [];
      const iosDevices = this.deviceImages.get("ios") || [];
      return [...androidDevices, ...iosDevices];
    }

    return this.deviceImages.get(platform) || [];
  }

  async isDeviceImageRunning(device: DeviceInfo): Promise<boolean> {
    const identifier = device.deviceId ?? device.name;
    this.executedOperations.push(`isDeviceImageRunning:${identifier}`);
    return this.runningDeviceNames.has(identifier) || this.runningDeviceNames.has(device.name);
  }

  async getBootedDevices(platform: SomePlatform): Promise<BootedDevice[]> {
    this.executedOperations.push(`getBootedDevices:${platform}`);

    if (platform === "either") {
      const androidDevices = this.bootedDevices.get("android") || [];
      const iosDevices = this.bootedDevices.get("ios") || [];
      return [...androidDevices, ...iosDevices];
    }

    return this.bootedDevices.get(platform) || [];
  }

  /**
   * Platforms whose discovery should report as failed/unavailable. Defaults to
   * all platforms succeeding.
   */
  failedPlatforms: Set<Platform> = new Set();

  /**
   * Individual discovery sources to report as failed, one level finer than
   * `failedPlatforms` (#5683). Failing `ios-physical` alone models the macOS
   * case where simctl completed but devicectl did not: the iOS platform still
   * aggregates as succeeded (it tracks the simulator source) while the physical
   * source is absent from `succeededSources`.
   */
  failedSources: Set<DiscoverySource> = new Set();

  /**
   * Omit `succeededSources` from the result to model a producer that predates
   * per-source reporting, exercising the consumer's platform-aggregate fallback.
   */
  omitSucceededSources: boolean = false;

  async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    const requested: Platform[] = platform === "either" ? ["android", "ios"] : [platform];
    const devices: BootedDevice[] = [];
    const succeededPlatforms = new Set<Platform>();
    const succeededSources = new Set<DiscoverySource>();
    const discoveryErrors: BootedDeviceDiscovery["discoveryErrors"] = {};
    for (const p of requested) {
      for (const source of sourcesForPlatform(p)) {
        if (!this.failedPlatforms.has(p) && !this.failedSources.has(source)) {
          succeededSources.add(source);
        }
      }
      // The platform aggregate mirrors production: iOS tracks the simulator
      // source, so a devicectl-only failure keeps the platform succeeded.
      const platformSource: DiscoverySource = p === "android" ? "android" : "ios-simulator";
      if (this.failedPlatforms.has(p) || this.failedSources.has(platformSource)) {
        discoveryErrors[p] = {
          code: "unavailable",
          message: `${p === "ios" ? "iOS" : "Android"} booted-device discovery is unavailable.`,
        };
        continue;
      }
      // Delegate to getBootedDevices so operation tracking stays consistent.
      devices.push(...(await this.getBootedDevices(p)));
      succeededPlatforms.add(p);
    }
    return {
      devices,
      succeededPlatforms,
      discoveryErrors,
      ...(this.omitSucceededSources ? {} : { succeededSources }),
    };
  }

  async getDeviceImagesDetailed(platform: SomePlatform): Promise<DeviceImageDiscovery> {
    const requested: Platform[] = platform === "either" ? ["android", "ios"] : [platform];
    const devices: DeviceInfo[] = [];
    const succeededPlatforms = new Set<Platform>();
    const discoveryErrors: DeviceImageDiscovery["discoveryErrors"] = {};
    for (const p of requested) {
      if (this.failedPlatforms.has(p)) {
        discoveryErrors[p] = {
          code: "unavailable",
          message: `${p === "ios" ? "iOS" : "Android"} device inventory is unavailable.`,
        };
        continue;
      }
      devices.push(...(await this.listDeviceImages(p)));
      succeededPlatforms.add(p);
    }
    return { devices, succeededPlatforms, discoveryErrors };
  }

  async startDevice(device: DeviceInfo, timeoutMs?: number): Promise<ChildProcess | null> {
    this.executedOperations.push(`startDevice:${device.name}:${timeoutMs ?? "default"}`);
    this.runningDeviceNames.add(device.name);
    if (device.deviceId) {
      this.runningDeviceNames.add(device.deviceId);
    }
    const bootedDevice: BootedDevice = {
      name: device.name,
      platform: device.platform,
      deviceId: device.deviceId || `mock-${device.name}`,
      source: device.source,
      iosVersion: device.iosVersion,
    };
    const existingBootedDevices = this.bootedDevices.get(device.platform) || [];
    if (!existingBootedDevices.some((booted) => booted.deviceId === bootedDevice.deviceId)) {
      this.bootedDevices.set(device.platform, [...existingBootedDevices, bootedDevice]);
    }

    // Return mock process if configured, otherwise return a default mock
    if (this.mockChildProcesses.has(device.name)) {
      return this.mockChildProcesses.get(device.name) ?? null;
    }

    // Return a minimal mock ChildProcess
    return {
      on: () => null,
      once: () => null,
      off: () => null,
      kill: () => false,
      stdout: null,
      stderr: null,
      stdin: null,
      pid: 12345,
    } as any as ChildProcess;
  }

  async killDevice(device: BootedDevice): Promise<void> {
    this.executedOperations.push(`killDevice:${device.name}`);
    this.runningDeviceNames.delete(device.name);
  }

  async destroyDevice(device: DeviceInfo, _options?: DeviceDestroyOptions): Promise<void> {
    this.executedOperations.push(
      `destroyDevice:${device.platform}:${device.deviceId ?? device.name}`,
    );
    const images = this.deviceImages.get(device.platform) ?? [];
    this.deviceImages.set(
      device.platform,
      images.filter((image) =>
        device.platform === "ios"
          ? (image.deviceId ?? image.name) !== (device.deviceId ?? device.name)
          : image.name !== device.name,
      ),
    );
  }

  async waitForDeviceReady(
    device: DeviceInfo,
    timeoutMs: number = 120000,
    childProcess?: ChildProcess | null,
    signal?: AbortSignal,
  ): Promise<BootedDevice> {
    this.waitForDeviceReadyChildProcess = childProcess;
    this.waitForDeviceReadySignal = signal;
    this.executedOperations.push(`waitForDeviceReady:${device.name}:${timeoutMs}`);

    if (this.waitForDeviceReadyError) {
      throw this.waitForDeviceReadyError;
    }

    // Return a booted device with the same name and platform
    return {
      name: device.name,
      platform: device.platform,
      deviceId: device.deviceId || `mock-${device.name}`,
      source: device.source,
    };
  }
}
