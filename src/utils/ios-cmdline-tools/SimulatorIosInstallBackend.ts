import type { IosInstallBackend, IosInstallBackendDeps } from "./IosDeviceBackend";

export class SimulatorIosInstallBackend implements IosInstallBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly simctl: IosInstallBackendDeps["simctl"],
  ) {}

  installApp(artifactPath: string, options?: { timeoutMs?: number }): Promise<void> {
    return this.simctl.installApp(
      artifactPath,
      this.deviceId,
      options?.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
    );
  }

  listApps(): Promise<Record<string, unknown>[]> {
    return this.simctl.listAppsOrThrow(this.deviceId);
  }
}
