import type { IosSimulatorPermissionCommandResult } from "../features/action/IosSimulatorPermissions";

export interface GrantIosSimulatorPermissionsResult {
  success: boolean;
  appId: string;
  deviceId: string;
  platform: "android" | "ios";
  grantedCount: number;
  failedCount: number;
  results: IosSimulatorPermissionCommandResult[];
  error?: string;
}
