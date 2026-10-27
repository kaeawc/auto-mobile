import type { DeviceUrlLauncher } from "./DeviceAppManager";
import type { IosOpenUrlBackend, IosOpenUrlBackendDeps } from "./IosDeviceBackend";

export class PhysicalIosOpenUrlBackend implements IosOpenUrlBackend {
  readonly kind = "physical";
  private launcher?: DeviceUrlLauncher;

  constructor(
    private readonly deviceId: string,
    private readonly createDeviceUrlLauncher: IosOpenUrlBackendDeps["createDeviceUrlLauncher"],
  ) {}

  private get deviceUrlLauncher(): DeviceUrlLauncher {
    return (this.launcher ??= this.createDeviceUrlLauncher());
  }

  isUrlLaunchAvailable(): Promise<boolean> {
    return this.deviceUrlLauncher.isUrlLaunchAvailable();
  }

  openUrl(url: string, options: { bundleId: string; signal?: AbortSignal }): Promise<void> {
    return this.deviceUrlLauncher.launchWithPayloadUrl(
      this.deviceId,
      options.bundleId,
      url,
      options.signal,
    );
  }
}
