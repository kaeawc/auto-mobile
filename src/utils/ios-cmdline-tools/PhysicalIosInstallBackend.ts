import type { IosInstallBackend, IosInstallBackendDeps } from "./IosDeviceBackend";

export class PhysicalIosInstallBackend implements IosInstallBackend {
  readonly kind = "physical";

  constructor(
    private readonly deviceId: string,
    private readonly deps: Pick<IosInstallBackendDeps, "deviceAppInstaller" | "physicalAppLister">,
  ) {}

  installApp(artifactPath: string): Promise<void> {
    return this.deps.deviceAppInstaller.installApp(this.deviceId, artifactPath);
  }

  listApps(): Promise<Record<string, unknown>[]> {
    return this.deps.physicalAppLister.listInstalledApps(this.deviceId);
  }
}
