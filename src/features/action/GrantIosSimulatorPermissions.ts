import type { BootedDevice, GrantIosSimulatorPermissionsResult } from "../../models";
import { IosSimulatorPermissions, type IosSimulatorPrivacyClient } from "./IosSimulatorPermissions";

export class GrantIosSimulatorPermissions {
  private permissions: IosSimulatorPermissions;

  constructor(device: BootedDevice, simctl: IosSimulatorPrivacyClient | null = null) {
    this.permissions = new IosSimulatorPermissions(device, simctl);
  }

  async execute(appId: string, permissions: string[]): Promise<GrantIosSimulatorPermissionsResult> {
    const result = await this.permissions.setPermissions("grant", appId, permissions);
    return {
      ...result,
      grantedCount: result.changedCount,
      results: result.results,
    };
  }
}
