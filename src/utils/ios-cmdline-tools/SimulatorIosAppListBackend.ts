import { type IosInstalledAppRecord } from "./iosInstalledApp";
import type { IosAppListBackend, IosAppListBackendDeps } from "./IosDeviceBackend";

export class SimulatorIosAppListBackend implements IosAppListBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly simctl: IosAppListBackendDeps["simctl"],
  ) {}

  listApps(): Promise<IosInstalledAppRecord[]> {
    return this.simctl.listAppsOrThrow(this.deviceId);
  }
}
