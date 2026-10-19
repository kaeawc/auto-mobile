import { logger } from "../logger";
import type { IosAppInfoBackend, IosAppInfoBackendDeps } from "./IosDeviceBackend";

export class SimulatorIosAppInfoBackend implements IosAppInfoBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly deps: IosAppInfoBackendDeps,
  ) {}

  async getAppInfo(bundleId: string): Promise<Record<string, unknown> | null> {
    let apps: Record<string, unknown>[];
    try {
      apps = await this.deps.iosSource.listApps(this.deviceId);
    } catch (error) {
      logger.warn(`[GetAppMetadata] Failed to list iOS apps: ${error}`);
      return null;
    }
    return this.deps.findAppByBundleId(apps, bundleId);
  }
}
