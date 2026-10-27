import type { IosOpenUrlBackend, IosOpenUrlBackendDeps } from "./IosDeviceBackend";

export class SimulatorIosOpenUrlBackend implements IosOpenUrlBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly createSimctl: IosOpenUrlBackendDeps["createSimctl"],
  ) {}

  async isUrlLaunchAvailable(): Promise<boolean> {
    return true;
  }

  async openUrl(url: string): Promise<void> {
    // Preserve argv forwarding: simctl's string command path re-splits URL bytes.
    await this.createSimctl().executeCommandArgs(["openurl", this.deviceId, url]);
  }
}
