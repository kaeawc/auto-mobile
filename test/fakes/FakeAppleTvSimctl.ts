import fixture from "../fixtures/ios-simctl/list-all-appletv-26-5.json";
import type { BootedDevice } from "../../src/models";
import type { AppleTvSimulatorCreator } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorProvisioner";
import type { AppleTvBootSimctl } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorBoot";
import type { AppleTvSimulatorSimctl } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import type {
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
  SimulatorList,
} from "../../src/utils/ios-cmdline-tools/SimCtlSupport";

/** Stateful simctl reads; set a value or an error per read. */
export class FakeAppleTvSimctl implements AppleTvSimulatorSimctl {
  listing: SimulatorList = { devices: {} };
  runtimes: AppleDeviceRuntime[] = [];
  deviceTypes: AppleDeviceType[] = [];
  listingError: Error | undefined;
  catalogError: Error | undefined;

  async listSimulators(): Promise<SimulatorList> {
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

export const TV_RUNTIME_ID = "com.apple.CoreSimulator.SimRuntime.tvOS-26-5";
export const TV_RUNTIME: AppleDeviceRuntime = fixture.runtimes.find(
  (entry) => entry.identifier === TV_RUNTIME_ID,
)!;
export const TV_DEVICE_TYPE: AppleDeviceType = fixture.devicetypes.find(
  (entry) => entry.productFamily === "Apple TV",
)!;
export function tvDevice(overrides: Partial<AppleDevice> = {}): AppleDevice {
  return { ...fixture.devices[TV_RUNTIME_ID][0], ...overrides };
}

/** Stateful create, boot, stop and delete; commands only change the in-memory listing. */
export class FakeAppleTvProvisionSimctl
  extends FakeAppleTvSimctl
  implements AppleTvSimulatorCreator, AppleTvBootSimctl
{
  readonly commands: string[] = [];
  onStateChange: (() => void) | undefined;
  createError: Error | undefined;
  deleteError: Error | undefined;
  bootError: Error | undefined;
  private created = 0;

  constructor(devices: AppleDevice[] = []) {
    super();
    this.listing = { devices: { [TV_RUNTIME_ID]: devices } };
    this.runtimes = [structuredClone(TV_RUNTIME)];
    this.deviceTypes = [structuredClone(TV_DEVICE_TYPE)];
  }

  async createSimulator(name: string, deviceType: string, runtime: string): Promise<string> {
    this.commands.push(`create ${name} ${deviceType} ${runtime}`);
    if (this.createError) {
      throw this.createError;
    }
    this.created++;
    const udid = `C0FFEE00-0000-4000-8000-${String(this.created).padStart(12, "0")}`;
    (this.listing.devices[runtime] ??= []).push(
      tvDevice({ udid, name, deviceTypeIdentifier: deviceType, state: "Shutdown" }),
    );
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

  async waitForSimulatorReady(udid: string, timeoutMs?: number): Promise<BootedDevice> {
    this.commands.push(`boot ${udid} ${timeoutMs}`);
    if (this.bootError) {
      throw this.bootError;
    }
    const device = this.setState(udid, "Booted");
    return { name: device.name, platform: "ios", deviceId: udid, observedAt: 7 };
  }

  async killSimulator(device: BootedDevice): Promise<void> {
    if (
      Object.values(this.listing.devices)
        .flat()
        .find((entry) => entry.udid === device.deviceId)?.state === "Shutdown"
    ) {
      return;
    }
    this.commands.push(`shutdown ${device.deviceId}`);
    this.setState(device.deviceId, "Shutdown");
  }

  private setState(udid: string, state: string): AppleDevice {
    const device = Object.values(this.listing.devices)
      .flat()
      .find((device) => device.udid === udid);
    if (!device) {
      throw new Error(`Invalid device: ${udid}`);
    }
    device.state = state;
    this.onStateChange?.();
    return device;
  }
}
