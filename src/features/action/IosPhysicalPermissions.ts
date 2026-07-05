import type { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import {
  normalizePermissions,
  type IosSimulatorPermissionAction,
  type IosSimulatorPermissionCommandResult,
  type IosSimulatorPermissionMutationResult,
} from "./IosSimulatorPermissions";

/**
 * Reset privacy authorizations on a *physical* iOS device through the CtrlProxy
 * XCUITest runner. The concrete client sends one `request_reset_permissions` per
 * permission so accounting stays per-permission and partial failures are reported
 * honestly (issue #2491).
 */
export interface IosPhysicalPrivacyClient {
  resetAuthorizations(
    appId: string,
    permissions: string[]
  ): Promise<IosSimulatorPermissionCommandResult[]>;
}

/**
 * Physical-iOS counterpart to {@link IosSimulatorPermissions}. Only the `reset`
 * action is possible on real hardware — there is no public API to set TCC to
 * allowed/denied — so `grant`/`revoke` return an explicit structured failure
 * naming the limitation rather than the old blanket simulator error. The result
 * shape mirrors the simulator path so `AppPermissions` maps both identically.
 */
export class IosPhysicalPermissions {
  constructor(
    private readonly device: BootedDevice,
    private readonly client: IosPhysicalPrivacyClient
  ) {}

  async setPermissions(
    action: IosSimulatorPermissionAction,
    appId: string,
    permissions: string[]
  ): Promise<IosSimulatorPermissionMutationResult> {
    const normalizedAppId = appId.trim();
    const normalizedPermissions = normalizePermissions(permissions);

    if (action !== "reset") {
      return this.mutationFailure(
        action,
        normalizedAppId,
        `iOS physical devices only support action=reset; '${action}' requires a simulator ` +
          "(no public TCC mutation API exists for real hardware)"
      );
    }

    if (!normalizedAppId) {
      return this.mutationFailure(action, normalizedAppId, "appId must be a non-empty iOS bundle identifier");
    }

    if (normalizedPermissions.length === 0) {
      return {
        success: true,
        appId: normalizedAppId,
        deviceId: this.device.deviceId,
        platform: "ios",
        action,
        changedCount: 0,
        failedCount: 0,
        results: [],
      };
    }

    const results = await this.client.resetAuthorizations(normalizedAppId, normalizedPermissions);
    const failedCount = results.filter(result => !result.success).length;

    return {
      success: failedCount === 0,
      appId: normalizedAppId,
      deviceId: this.device.deviceId,
      platform: "ios",
      action,
      changedCount: results.length - failedCount,
      failedCount,
      results,
      ...(failedCount > 0 ? { error: `One or more iOS physical permissions failed to ${action}` } : {}),
    };
  }

  private mutationFailure(
    action: IosSimulatorPermissionAction,
    appId: string,
    error: string
  ): IosSimulatorPermissionMutationResult {
    return {
      success: false,
      appId,
      deviceId: this.device.deviceId,
      platform: "ios",
      action,
      changedCount: 0,
      failedCount: 0,
      results: [],
      error,
    };
  }
}

/**
 * Production {@link IosPhysicalPrivacyClient} backed by the CtrlProxy runner
 * WebSocket (port 8765). Sends one reset request per permission and adapts each
 * runner response into a per-permission result. When the runner is unreachable the
 * shared not-connected path yields a clear, actionable error on every permission.
 */
export class CtrlProxyIosPhysicalPrivacyClient implements IosPhysicalPrivacyClient {
  constructor(
    private readonly device: BootedDevice,
    private readonly getClient: () => IOSCtrlProxyClient = () => IOSCtrlProxyClient.getInstance(this.device)
  ) {}

  async resetAuthorizations(
    appId: string,
    permissions: string[]
  ): Promise<IosSimulatorPermissionCommandResult[]> {
    const client = this.getClient();
    return Promise.all(
      permissions.map(async permission => {
        try {
          const response = await client.requestResetPermissions(appId, [permission]);
          return response.success
            ? { permission, success: true }
            : { permission, success: false, error: response.error ?? "Failed to reset permission" };
        } catch (error) {
          // Best-effort per-permission path: log the unexpected failure (so there is
          // a trace even though the message is also surfaced in the result) and
          // report it as a typed failure rather than aborting the whole batch.
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`[IosPhysicalPermissions] reset of '${permission}' failed: ${message}`, error);
          return { permission, success: false, error: message };
        }
      })
    );
  }
}
