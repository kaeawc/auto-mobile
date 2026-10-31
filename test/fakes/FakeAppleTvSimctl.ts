import type { AppleTvSimulatorSimctl } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import type {
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
