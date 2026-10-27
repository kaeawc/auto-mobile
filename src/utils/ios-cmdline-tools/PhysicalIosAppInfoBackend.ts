import { logger } from "../logger";
import type { IosAppMetadataSource } from "../../models/IosAppMetadataSource";
import type { IosAppInfoBackend } from "./IosDeviceBackend";

export class PhysicalIosAppInfoBackend implements IosAppInfoBackend {
  readonly kind = "physical";

  constructor(
    private readonly deviceId: string,
    private readonly iosSource: Pick<IosAppMetadataSource, "getPhysicalDeviceAppInfo">,
  ) {}

  async getAppInfo(bundleId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.iosSource.getPhysicalDeviceAppInfo(this.deviceId, bundleId);
    } catch (error) {
      logger.warn(`[GetAppMetadata] Failed to get physical device app info: ${error}`);
      return null;
    }
  }
}
