import type { IdGenerator } from "../../src/utils/IdGenerator";
import { FakeIdGenerator } from "./FakeIdGenerator";
import fixture from "../fixtures/ios-simctl/list-all-visionos-26-5.json";
import type { BootedDevice } from "../../src/models";
import type { AppleVisionSimulatorCreator } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorProvisioner";
import type { AppleVisionBootSimctl } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorBoot";
import type { AppleVisionSimulatorSimctl } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import type {
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
  SimulatorList,
} from "../../src/utils/ios-cmdline-tools/SimCtlSupport";

/** Stateful simctl reads; set a value or an error per read. */
export class FakeAppleVisionSimctl implements AppleVisionSimulatorSimctl {
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

export const VISION_RUNTIME_ID = "com.apple.CoreSimulator.SimRuntime.xrOS-26-5";
export const VISION_RUNTIME: AppleDeviceRuntime = fixture.runtimes.find(
  (entry) => entry.identifier === VISION_RUNTIME_ID,
)!;
export const VISION_DEVICE_TYPE: AppleDeviceType = fixture.devicetypes.find(
  (entry) => entry.productFamily === "Apple Vision",
)!;
export function visionDevice(overrides: Partial<AppleDevice> = {}): AppleDevice {
  return {
    ...fixture.devices[VISION_RUNTIME_ID][0],
    udid: "C0FFEE00-0000-4000-8000-000000000099",
    name: "Fake Vision Pro",
    ...overrides,
  };
}

/** Stateful create, boot, stop and delete; commands only change the in-memory listing. */
export class FakeAppleVisionProvisionSimctl
  extends FakeAppleVisionSimctl
  implements AppleVisionSimulatorCreator, AppleVisionBootSimctl
{
  readonly commands: string[] = [];
  onStateChange: (() => void) | undefined;
  createError: Error | undefined;
  deleteError: Error | undefined;
  bootError: Error | undefined;

  constructor(
    devices: AppleDevice[] = [],
    private readonly ids: IdGenerator = new FakeIdGenerator([
      "C0FFEE00-0000-4000-8000-000000000001",
    ]),
  ) {
    super();
    this.listing = { devices: { [VISION_RUNTIME_ID]: devices } };
    this.runtimes = [structuredClone(VISION_RUNTIME)];
    this.deviceTypes = [structuredClone(VISION_DEVICE_TYPE)];
  }

  async createSimulator(name: string, deviceType: string, runtime: string): Promise<string> {
    this.commands.push(`create ${name} ${deviceType} ${runtime}`);
    if (this.createError) {
      throw this.createError;
    }
    const udid = this.ids.next();
    (this.listing.devices[runtime] ??= []).push(
      visionDevice({ udid, name, deviceTypeIdentifier: deviceType, state: "Shutdown" }),
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
