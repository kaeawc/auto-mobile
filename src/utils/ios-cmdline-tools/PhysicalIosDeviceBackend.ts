import type { IosDeviceBackend, IosDeviceBackendDeps } from "./IosDeviceBackend";

export class PhysicalIosDeviceBackend implements IosDeviceBackend {
  readonly kind = "physical";

  constructor(
    private readonly deviceId: string,
    private readonly deps: Pick<IosDeviceBackendDeps, "deviceAppUninstaller">,
  ) {}

  uninstallApp(
    bundleId: string,
    _signal?: AbortSignal,
    _options?: { terminateFirst?: boolean },
  ): Promise<void> {
    return this.deps.deviceAppUninstaller.uninstallApp(this.deviceId, bundleId, false);
  }
}
