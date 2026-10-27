import type { SimCtlClient } from "./SimCtlClient";
import type { IosLaunchBackend, LaunchOptions, LaunchResult } from "./IosDeviceBackend";

export class SimulatorIosLaunchBackend implements IosLaunchBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly simctl: Pick<SimCtlClient, "launchApp">,
  ) {}

  launchApp(bundleId: string, options?: LaunchOptions): Promise<LaunchResult> {
    return this.simctl.launchApp(bundleId, options, this.deviceId);
  }
}
