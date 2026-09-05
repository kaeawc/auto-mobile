import { errorMessage } from "../../utils/describeUnknownError";
import type { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import {
  normalizePermissions,
  type IosSimulatorPermissionAction,
  type IosSimulatorPermissionCommandResult,
  type IosSimulatorPermissionMutationResult,
} from "./IosSimulatorPermissions";

// Every AutoMobile permission name that maps to a resettable iOS
// `XCUIProtectedResource` (Xcode 26.3 header). Keep in lock-step with the
// authoritative Swift list in
// `ios/control-proxy/Sources/CtrlProxyRewrite/GesturePerformer.swift`
// (`allResettablePrivacyResourceNames`); the direct Swift runner `all`
// expansion must reset the same set. `local-network` maps to
// `XCUIProtectedResourceLocalNetwork` which is iOS 15.4+, so the runner
// reports it as an honest per-permission failure on older OS versions.
const IOS_PHYSICAL_RESET_ALL_PERMISSIONS = [
  "camera",
  "photos",
  "microphone",
  "contacts",
  "location",
  "calendar",
  "reminders",
  "media-library",
  "homekit",
  "focus",
  "local-network",
  "bluetooth",
  "keyboard-network",
  "health",
  "user-tracking",
];

const IOS_PHYSICAL_RESET_CANONICAL_PERMISSION = new Map<string, string>([
  ["photos-add", "photos"],
  ["contacts-limited", "contacts"],
  ["location-always", "location"],
]);

function canonicalIosPhysicalResetPermission(permission: string): string {
  return IOS_PHYSICAL_RESET_CANONICAL_PERMISSION.get(permission) ?? permission;
}

function expandIosPhysicalResetPermissions(permissions: string[]): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();

  for (const permission of permissions) {
    const permissionsToAdd =
      permission === "all" ? IOS_PHYSICAL_RESET_ALL_PERMISSIONS : [permission];

    for (const expandedPermission of permissionsToAdd) {
      const canonicalPermission = canonicalIosPhysicalResetPermission(expandedPermission);
      if (seen.has(canonicalPermission)) {
        continue;
      }
      seen.add(canonicalPermission);
      expanded.push(expandedPermission);
    }
  }

  return expanded;
}

/**
 * Reset privacy authorizations on a *physical* iOS device through the CtrlProxy
 * XCUITest runner. The concrete client sends one `request_reset_permissions` per
 * permission so accounting stays per-permission and partial failures are reported
 * honestly (issue #2491).
 */
export interface IosPhysicalPrivacyClient {
  resetAuthorizations(
    appId: string,
    permissions: string[],
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
    private readonly client: IosPhysicalPrivacyClient,
  ) {}

  async setPermissions(
    action: IosSimulatorPermissionAction,
    appId: string,
    permissions: string[],
  ): Promise<IosSimulatorPermissionMutationResult> {
    const normalizedAppId = appId.trim();
    const normalizedPermissions = normalizePermissions(permissions);

    if (action !== "reset") {
      return this.mutationFailure(
        action,
        normalizedAppId,
        `iOS physical devices only support action=reset; '${action}' requires a simulator ` +
          "(no public TCC mutation API exists for real hardware)",
      );
    }

    if (!normalizedAppId) {
      return this.mutationFailure(
        action,
        normalizedAppId,
        "appId must be a non-empty iOS bundle identifier",
      );
    }

    const permissionsToReset = expandIosPhysicalResetPermissions(normalizedPermissions);

    if (permissionsToReset.length === 0) {
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

    const results = await this.client.resetAuthorizations(normalizedAppId, permissionsToReset);
    const failedCount = results.filter((result) => !result.success).length;

    return {
      success: failedCount === 0,
      appId: normalizedAppId,
      deviceId: this.device.deviceId,
      platform: "ios",
      action,
      changedCount: results.length - failedCount,
      failedCount,
      results,
      ...(failedCount > 0
        ? { error: `One or more iOS physical permissions failed to ${action}` }
        : {}),
    };
  }

  private mutationFailure(
    action: IosSimulatorPermissionAction,
    appId: string,
    error: string,
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
    private readonly getClient: () => IOSCtrlProxyClient = () =>
      IOSCtrlProxyClient.getInstance(this.device),
  ) {}

  async resetAuthorizations(
    appId: string,
    permissions: string[],
  ): Promise<IosSimulatorPermissionCommandResult[]> {
    const client = this.getClient();
    return Promise.all(
      permissions.map(async (permission) => {
        try {
          const response = await client.requestResetPermissions(appId, [permission]);
          return response.success
            ? { permission, success: true }
            : { permission, success: false, error: response.error ?? "Failed to reset permission" };
        } catch (error) {
          // Best-effort per-permission path: log the unexpected failure (so there is
          // a trace even though the message is also surfaced in the result) and
          // report it as a typed failure rather than aborting the whole batch.
          const message = errorMessage(error);
          logger.warn(
            `[IosPhysicalPermissions] reset of '${permission}' failed: ${message}`,
            error,
          );
          return { permission, success: false, error: message };
        }
      }),
    );
  }
}
