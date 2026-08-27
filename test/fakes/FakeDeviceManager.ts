import { ChildProcess } from "child_process";
import { BootedDevice, DeviceInfo, Platform, SomePlatform } from "../../src/models";
import { BootedDeviceDiscovery, PlatformDeviceManager } from "../../src/utils/deviceUtils";
import { discoverySourceFor, type DiscoverySource } from "../../src/utils/discoverySource";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";

export class FakeDeviceManager implements PlatformDeviceManager {
  deviceImages: DeviceInfo[] = [];
  bootedDevices: BootedDevice[] = [];
  startedDevices: DeviceInfo[] = [];
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
    const discoveryErrors: BootedDeviceDiscovery["discoveryErrors"] = {};
    const sourceFailed = (source: DiscoverySource, p: Platform): boolean =>
      this.failedPlatforms.has(p) || this.failedSources.has(source);
    for (const p of requested) {
      const platformSources: DiscoverySource[] =
        p === "android" ? ["android"] : ["ios-simulator", "ios-physical"];
      for (const source of platformSources) {
        const failed = sourceFailed(source, p);
        if (failed && !this.retainedSources.has(source)) {
          continue;
        }
        if (!failed) {
          succeededSources.add(source);
        }
        devices.push(
          ...this.bootedDevices.filter(
            (device) => device.platform === p && discoverySourceFor(p, device.deviceId) === source,
          ),
        );
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
    return { devices, succeededPlatforms, succeededSources, discoveryErrors };
  }

  async startDevice(
    device: DeviceInfo,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  ): Promise<ChildProcess> {
    this.startedDevices.push(device);
    this.startDeviceTimeouts.push(timeoutMs);
    const id = device.deviceId ?? device.name;
    const alreadyBooted = this.bootedDevices.some((booted) => booted.deviceId === id);
    if (!alreadyBooted) {
      this.bootedDevices.push({
        name: device.name,
        platform: device.platform,
        deviceId: id,
        source: device.source,
        iosVersion: device.iosVersion,
      });
    }
    return { pid: 0 } as ChildProcess;
  }

  async killDevice(_: BootedDevice): Promise<void> {}

  async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
    const id = device.deviceId ?? device.name;
    return {
      name: device.name,
      platform: device.platform,
      deviceId: id,
      source: device.source,
      iosVersion: device.iosVersion,
    };
  }
}
