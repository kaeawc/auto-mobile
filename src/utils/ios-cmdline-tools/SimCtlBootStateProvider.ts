import type { SimulatorBootStateProvider } from "./CoreDeviceCapabilityProbe";
import type { SimCtl } from "./SimCtlClient";

/** Reads simulator state through the existing simctl client without additional caching. */
export class SimCtlBootStateProvider implements SimulatorBootStateProvider {
  constructor(private readonly simctl: Pick<SimCtl, "getDeviceInfo">) {}

  async getBootState(deviceId: string): Promise<"booted" | "shutdown" | "unknown"> {
    const device = await this.simctl.getDeviceInfo(deviceId);
    switch (device?.state) {
      case "Booted":
        return "booted";
      case "Shutdown":
        return "shutdown";
      default:
        return "unknown";
    }
  }
}
