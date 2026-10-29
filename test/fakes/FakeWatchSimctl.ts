import type { WatchSimulatorSimctl } from "../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
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
