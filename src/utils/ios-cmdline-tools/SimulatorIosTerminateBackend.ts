import type { SimCtlClient } from "./SimCtlClient";
import type { IosTerminateBackend, TerminateResult } from "./IosDeviceBackend";

export class SimulatorIosTerminateBackend implements IosTerminateBackend {
  readonly kind = "simulator";

  readonly requiresInstalledAppCheck = true;

  constructor(
    private readonly deviceId: string,
    private readonly simctl: Pick<SimCtlClient, "terminateApp">,
  ) {}

  async terminateApp(bundleId: string): Promise<TerminateResult> {
    await this.simctl.terminateApp(bundleId, this.deviceId);
    return { wasInstalled: true, wasRunning: true };
  }
}
