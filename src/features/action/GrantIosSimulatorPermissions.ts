import type { BootedDevice, ExecResult, GrantIosSimulatorPermissionsResult } from "../../models";
import { IosSimulatorPermissions } from "./IosSimulatorPermissions";

interface IosSimulatorPrivacyClient {
  executeCommand(command: string, timeoutMs?: number): Promise<ExecResult>;
}

export class GrantIosSimulatorPermissions {
  private permissions: IosSimulatorPermissions;

  constructor(
    device: BootedDevice,
    simctl: IosSimulatorPrivacyClient | null = null
  ) {
    this.permissions = new IosSimulatorPermissions(device, simctl);
  }

  async execute(appId: string, permissions: string[]): Promise<GrantIosSimulatorPermissionsResult> {
    const result = await this.permissions.setPermissions("grant", appId, permissions);
    return {
      ...result,
      grantedCount: result.changedCount,
      results: result.results
    };
  }
}
