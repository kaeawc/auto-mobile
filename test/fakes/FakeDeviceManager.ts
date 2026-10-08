import { ChildProcess } from "child_process";
import { BootedDevice, DeviceInfo, Platform, SomePlatform } from "../../src/models";
import {
  BootedDeviceDiscovery,
  DeviceImageDiscovery,
  DeviceImageDiscoveryOptions,
  DeviceStartResult,
  PlatformDeviceManager,
} from "../../src/devices/deviceUtils";
import type { AndroidEmulatorLaunchOutcome } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { discoverySourceFor, type DiscoverySource } from "../../src/utils/discoverySource";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";

export class FakeDeviceManager implements PlatformDeviceManager {
  deviceImages: DeviceInfo[] = [];
  bootedDevices: BootedDevice[] = [];
  startedDevices: DeviceInfo[] = [];
  /**
   * How the next starts obtain their device, as `AndroidEmulatorClient` reports it:
   * - `launched`: a new process; the device becomes visible.
   * - `joined-in-process-launch` / `already-running`: no process of this start's own, and the
   *   device becomes (or already is) visible to this daemon's adb.
   * - `duplicate-of-external`: no process; the external emulator becomes visible to this
   *   daemon's adb only when `startVisibleDeviceId` is set.
   */
  startOutcome: AndroidEmulatorLaunchOutcome = "launched";
  /** Serial a non-launched start's device appears under; defaults to the image's id or name. */
  startVisibleDeviceId: string | undefined;
  startDeviceTimeouts: Array<number | undefined> = [];
  // Platforms whose discovery should report as failed/unavailable (used to
  // exercise partial-discovery handling). Defaults to all platforms succeeding.
  failedPlatforms: Set<Platform> = new Set();
  // Individual discovery sources that should report as failed. iOS has two
  // (simctl and devicectl) and either can fail alone (#5683); a source listed
  // here is absent from `succeededSources`.
  failedSources: Set<DiscoverySource> = new Set();
  // Failed sources that still replay their last-good listing, which is what
  // `DevicectlDeviceLister` does for up to 60s behind `complete: false`. A
  // source listed here contributes its devices while staying absent from
  // `succeededSources`, so a consumer that mistakes presence for a fresh
  // observation is caught.
  retainedSources: Set<DiscoverySource> = new Set();
  deviceImageDiscoveryCalls: Array<{
    platform: SomePlatform;
    options: DeviceImageDiscoveryOptions;
  }> = [];

  constructor(images: DeviceInfo[] = [], booted: BootedDevice[] = []) {
    this.deviceImages = images;
    this.bootedDevices = booted;
  }

  async listDeviceImages(platform: SomePlatform): Promise<DeviceInfo[]> {
    if (platform === "either") {
      return this.deviceImages;
    }
    return this.deviceImages.filter((device) => device.platform === platform);
  }

  async getDeviceImagesDetailed(
    platform: SomePlatform,
    options: DeviceImageDiscoveryOptions = {},
  ): Promise<DeviceImageDiscovery> {
    this.deviceImageDiscoveryCalls.push({ platform, options });
    const requested: Platform[] = platform === "either" ? ["android", "ios"] : [platform];
    const succeededPlatforms = new Set<Platform>();
    const discoveryErrors: DeviceImageDiscovery["discoveryErrors"] = {};
    for (const requestedPlatform of requested) {
      if (this.failedPlatforms.has(requestedPlatform)) {
        discoveryErrors[requestedPlatform] = {
          code: "unavailable",
          message: `${requestedPlatform === "ios" ? "iOS" : "Android"} device inventory is unavailable.`,
        };
      } else {
        succeededPlatforms.add(requestedPlatform);
      }
    }
    return {
      devices: this.deviceImages.filter(
        (device) => requested.includes(device.platform) && succeededPlatforms.has(device.platform),
      ),
      succeededPlatforms,
      discoveryErrors,
    };
  }

  async isDeviceImageRunning(device: DeviceInfo): Promise<boolean> {
    if (device.isRunning) {
      return true;
    }
    const id = device.deviceId ?? device.name;
    return this.bootedDevices.some(
      (booted) => booted.deviceId === id || booted.name === device.name,
    );
  }

  async getBootedDevices(platform: SomePlatform): Promise<BootedDevice[]> {
    // Honour the same failure configuration as `getBootedDevicesDetailed`, so a
    // test cannot bypass a configured source failure through this path.
    return this.bootedDevices.filter((device) => {
      if (platform !== "either" && device.platform !== platform) {
        return false;
      }
      const source = discoverySourceFor(device.platform, device.deviceId);
      return (
        (!this.failedPlatforms.has(device.platform) && !this.failedSources.has(source)) ||
        this.retainedSources.has(source)
      );
    });
  }

  async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    const requested: Platform[] = platform === "either" ? ["android", "ios"] : [platform];
    const devices: BootedDevice[] = [];
    const succeededPlatforms = new Set<Platform>();
    const succeededSources = new Set<DiscoverySource>();
    const freshDeviceIds = new Set<string>();
    const discoveryErrors: BootedDeviceDiscovery["discoveryErrors"] = {};
    const sourceErrors: BootedDeviceDiscovery["sourceErrors"] = {};
    const sourceFailed = (source: DiscoverySource, p: Platform): boolean =>
      this.failedPlatforms.has(p) || this.failedSources.has(source);
    for (const p of requested) {
      const platformSources: DiscoverySource[] =
        p === "android" ? ["android"] : ["ios-simulator", "ios-physical"];
      for (const source of platformSources) {
        const failed = sourceFailed(source, p);
        if (failed && source === "ios-physical") {
          sourceErrors[source] = {
            code: "failed",
            message: "devicectl could not list physical iOS devices (failed): fake",
          };
        }
        const reportsDevices = !failed || this.retainedSources.has(source);
        if (!reportsDevices) {
          continue;
        }
        if (!failed) {
          succeededSources.add(source);
        }
        const fromSource = this.bootedDevices.filter(
          (device) => device.platform === p && discoverySourceFor(p, device.deviceId) === source,
        );
        devices.push(...fromSource);
        // A retained source replays devices it saw earlier; they are reported
        // but were not observed this sweep.
        if (!failed) {
          for (const device of fromSource) {
            freshDeviceIds.add(device.deviceId);
          }
        }
      }
      // Mirrors production: the platform aggregate tracks the simulator source
      // for iOS, so platform-level consumers keep their pre-#5683 meaning.
      const platformSucceeded = !sourceFailed(p === "android" ? "android" : "ios-simulator", p);
      if (platformSucceeded) {
        succeededPlatforms.add(p);
      } else {
        discoveryErrors[p] = {
          code: "unavailable",
          message: `${p === "ios" ? "iOS" : "Android"} booted-device discovery is unavailable.`,
        };
      }
    }
    return {
      devices,
      succeededPlatforms,
      succeededSources,
      freshDeviceIds,
      discoveryErrors,
      ...(Object.keys(sourceErrors).length > 0 ? { sourceErrors } : {}),
    };
  }

  async startDevice(
    device: DeviceInfo,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  ): Promise<ChildProcess | null> {
    this.startedDevices.push(device);
    this.startDeviceTimeouts.push(timeoutMs);
    const outcome = this.startOutcome;
    if (outcome !== "duplicate-of-external" || this.startVisibleDeviceId !== undefined) {
      const id =
        outcome === "launched"
          ? (device.deviceId ?? device.name)
          : (this.startVisibleDeviceId ?? device.deviceId ?? device.name);
      if (!this.bootedDevices.some((booted) => booted.deviceId === id)) {
        this.bootedDevices.push({
          name: device.name,
          platform: device.platform,
          deviceId: id,
          source: device.source,
          iosVersion: device.iosVersion,
        });
      }
    }
    return outcome === "launched" ? ({ pid: 0 } as ChildProcess) : null;
  }

  /** Delegates to `startDevice`, so subclasses that override it keep their process handles. */
  async startDeviceWithOutcome(
    device: DeviceInfo,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  ): Promise<DeviceStartResult> {
    const process = await this.startDevice(device, timeoutMs);
    if (process) {
      return { process, outcome: "launched" };
    }
    return {
      process: null,
      outcome: this.startOutcome === "launched" ? "already-running" : this.startOutcome,
    };
  }

  async killDevice(_: BootedDevice): Promise<void> {}

  async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
    const id =
      device.deviceId ??
      this.bootedDevices.find(
        (booted) => booted.platform === device.platform && booted.name === device.name,
      )?.deviceId ??
      device.name;
    return {
      name: device.name,
      platform: device.platform,
      deviceId: id,
      source: device.source,
      iosVersion: device.iosVersion,
    };
  }
}
