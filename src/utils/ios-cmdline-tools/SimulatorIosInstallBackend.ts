import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../deviceTimeouts";
import type { IosInstallBackend, IosInstallBackendDeps } from "./IosDeviceBackend";

export class SimulatorIosInstallBackend implements IosInstallBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly simctl: IosInstallBackendDeps["simctl"],
  ) {}

  installApp(
    artifactPath: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    // Large app bundles get an explicit budget; a downgrade reinstall keeps its own deadline.
    return this.simctl.installApp(artifactPath, this.deviceId, {
      ...options,
      timeoutMs: options?.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS,
    });
  }

  listApps(): Promise<Record<string, unknown>[]> {
    return this.simctl.listAppsOrThrow(this.deviceId);
  }
}
