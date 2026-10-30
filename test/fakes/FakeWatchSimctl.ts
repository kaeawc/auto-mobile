import type { WatchSimulatorSimctl } from "../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import type { BootedDevice } from "../../src/models";
import type { WatchLifecycleSimctl } from "../../src/utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import type { WatchSimulatorCreator } from "../../src/utils/ios-cmdline-tools/WatchSimulatorProvisioner";
import type {
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
  SimulatorList,
} from "../../src/utils/ios-cmdline-tools/SimCtlSupport";

export const WATCH_RUNTIME_ID = "com.apple.CoreSimulator.SimRuntime.watchOS-11-0";
export const IOS_RUNTIME_ID = "com.apple.CoreSimulator.SimRuntime.iOS-18-6";

/** `simctl list runtimes --json` entry for watchOS 11.0, in simctl's shape. */
export const WATCH_RUNTIME: AppleDeviceRuntime = {
  bundlePath:
    "/Library/Developer/CoreSimulator/Volumes/watchOS_22R349/Library/Developer/CoreSimulator/Profiles/Runtimes/watchOS 11.0.simruntime",
  buildversion: "22R349",
  runtimeRoot:
    "/Library/Developer/CoreSimulator/Volumes/watchOS_22R349/Library/Developer/CoreSimulator/Profiles/Runtimes/watchOS 11.0.simruntime/Contents/Resources/RuntimeRoot",
  identifier: WATCH_RUNTIME_ID,
  version: "11.0",
  isAvailable: true,
  name: "watchOS 11.0",
};

/** `simctl list devicetypes --json` entry for an Apple Watch, in simctl's shape. */
export const WATCH_DEVICE_TYPE: AppleDeviceType = {
  productFamily: "Apple Watch",
  bundlePath:
    "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/Apple Watch Series 10 (46mm).simdevicetype",
  maxRuntimeVersion: 4294967295,
  maxRuntimeVersionString: "65535.255.255",
  identifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm",
  modelIdentifier: "Watch7,11",
  minRuntimeVersionString: "11.0.0",
  minRuntimeVersion: 720896,
  name: "Apple Watch Series 10 (46mm)",
};

export function watchDevice(overrides: Partial<AppleDevice> = {}): AppleDevice {
  return {
    udid: "6B1F3C2E-0000-4000-8000-00000000A7C1",
    name: "Apple Watch Series 10 (46mm)",
    state: "Shutdown",
    isAvailable: true,
    deviceTypeIdentifier: WATCH_DEVICE_TYPE.identifier,
    ...overrides,
  };
}

/** Stateful simctl reads for watch inventory tests; set a value or an error per read. */
export class FakeWatchSimctl implements WatchSimulatorSimctl {
  listing: SimulatorList = { devices: {} };
  runtimes: AppleDeviceRuntime[] = [];
  deviceTypes: AppleDeviceType[] = [];
  listingError: Error | undefined;
  catalogError: Error | undefined;
  listingCalls = 0;

  async listSimulators(): Promise<SimulatorList> {
    this.listingCalls++;
    if (this.listingError) {
      throw this.listingError;
    }
    return this.listing;
  }

  async getRuntimesChecked(): Promise<AppleDeviceRuntime[]> {
    if (this.catalogError) {
      throw this.catalogError;
    }
    return this.runtimes;
  }

  async getDeviceTypesChecked(): Promise<AppleDeviceType[]> {
    if (this.catalogError) {
      throw this.catalogError;
    }
    return this.deviceTypes;
  }
}

export const IPHONE_UDID = "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6";

/**
 * A simctl host with a stateful boot and shutdown over {@link FakeWatchSimctl}'s listing: a boot
 * turns the device `Booted` (labelled "ios", as the shared boot path does) and a shutdown turns it
 * `Shutdown`. Every boot/shutdown command is logged in `commands`.
 */
export class FakeWatchLifecycleSimctl extends FakeWatchSimctl implements WatchLifecycleSimctl {
  readonly commands: string[] = [];
  onStateChange: (() => void) | undefined;
  /** When set, a boot is logged and then fails with this error, leaving the watch shut down. */
  bootError: Error | undefined;

  constructor(devices: AppleDevice[] = [watchDevice()]) {
    super();
    this.listing = {
      devices: {
        [WATCH_RUNTIME_ID]: devices,
        [IOS_RUNTIME_ID]: [
          { udid: IPHONE_UDID, name: "iPhone 16", state: "Booted", isAvailable: true },
        ],
      },
    };
  }

  async waitForSimulatorReady(udid: string, timeoutMs?: number): Promise<BootedDevice> {
    this.commands.push(`boot ${udid} ${timeoutMs}`);
    if (this.bootError) {
      throw this.bootError;
    }
    const device = this.setState(udid, "Booted");
    return { name: device.name, platform: "ios", deviceId: udid, observedAt: 7 };
  }

  async killSimulator(device: BootedDevice): Promise<void> {
    this.commands.push(`shutdown ${device.deviceId}`);
    this.setState(device.deviceId, "Shutdown");
  }

  stateOf(udid: string): string | undefined {
    return this.find(udid)?.state;
  }

  private setState(udid: string, state: string): AppleDevice {
    const device = this.find(udid);
    if (!device) {
      throw new Error(`Invalid device: ${udid}`);
    }
    device.state = state;
    this.onStateChange?.();
    return device;
  }

  private find(udid: string): AppleDevice | undefined {
    return Object.values(this.listing.devices)
      .flat()
      .find((device) => device.udid === udid);
  }
}

/**
 * {@link FakeWatchLifecycleSimctl} plus `simctl create`: a device type and runtime from the fake's
 * catalog add a shutdown watch under that runtime with the next UDID, and anything else fails as
 * simctl does; `simctl delete` removes a listed device. Creates and deletes are logged in
 * `commands`.
 */
export class FakeWatchProvisionSimctl
  extends FakeWatchLifecycleSimctl
  implements WatchSimulatorCreator
{
  createError: Error | undefined;
  deleteError: Error | undefined;
  private created = 0;

  constructor(devices: AppleDevice[] = []) {
    super(devices);
    this.runtimes = [WATCH_RUNTIME];
    this.deviceTypes = [WATCH_DEVICE_TYPE];
  }

  async createSimulator(name: string, deviceType: string, runtime: string): Promise<string> {
    this.commands.push(`create ${name} ${deviceType} ${runtime}`);
    if (this.createError) {
      throw this.createError;
    }
    if (!this.deviceTypes.some((type) => type.identifier === deviceType)) {
      throw new Error(`Invalid device type: ${deviceType}`);
    }
    if (!this.runtimes.some((entry) => entry.identifier === runtime)) {
      throw new Error(`Invalid runtime: ${runtime}`);
    }
    this.created++;
    const udid = `C0FFEE00-0000-4000-8000-${String(this.created).padStart(12, "0")}`;
    const devices = (this.listing.devices[runtime] ??= []);
    devices.push(watchDevice({ udid, name, deviceTypeIdentifier: deviceType }));
    return udid;
  }

  async deleteSimulator(udid: string): Promise<void> {
    this.commands.push(`delete ${udid}`);
    if (this.deleteError) {
      throw this.deleteError;
    }
    for (const [runtime, devices] of Object.entries(this.listing.devices)) {
      this.listing.devices[runtime] = devices.filter((device) => device.udid !== udid);
    }
  }
}
