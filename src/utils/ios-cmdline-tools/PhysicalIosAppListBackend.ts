import { type IosInstalledAppRecord } from "./iosInstalledApp";
import type { IosAppListBackend, IosAppListBackendDeps } from "./IosDeviceBackend";

export class PhysicalIosAppListBackend implements IosAppListBackend {
  readonly kind = "physical";

  constructor(
    private readonly deviceId: string,
    private readonly getPhysicalAppLister: IosAppListBackendDeps["getPhysicalAppLister"],
  ) {}

  listApps(): Promise<IosInstalledAppRecord[]> {
    return this.getPhysicalAppLister().listInstalledApps(this.deviceId);
  }
}
