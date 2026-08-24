import { ChildProcess } from "child_process";
import { BootedDevice, DeviceInfo, Platform, SomePlatform } from "../../src/models";
import { BootedDeviceDiscovery, PlatformDeviceManager } from "../../src/utils/deviceUtils";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";

export class FakeDeviceManager implements PlatformDeviceManager {
  deviceImages: DeviceInfo[] = [];
  bootedDevices: BootedDevice[] = [];
  startedDevices: DeviceInfo[] = [];
  startDeviceTimeouts: Array<number | undefined> = [];
  // Platforms whose discovery should report as failed/unavailable (used to
  // exercise partial-discovery handling). Defaults to all platforms succeeding.
  failedPlatforms: Set<Platform> = new Set();

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
    if (platform === "either") {
      return this.bootedDevices;
    }
    return this.bootedDevices.filter((device) => device.platform === platform);
  }

  async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    const requested: Platform[] = platform === "either" ? ["android", "ios"] : [platform];
    const devices: BootedDevice[] = [];
    const succeededPlatforms = new Set<Platform>();
    const discoveryErrors: BootedDeviceDiscovery["discoveryErrors"] = {};
    for (const p of requested) {
      if (this.failedPlatforms.has(p)) {
        discoveryErrors[p] = {
          code: "unavailable",
          message: `${p === "ios" ? "iOS" : "Android"} booted-device discovery is unavailable.`,
        };
        continue;
      }
      succeededPlatforms.add(p);
      devices.push(...this.bootedDevices.filter((device) => device.platform === p));
    }
    return { devices, succeededPlatforms, discoveryErrors };
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
