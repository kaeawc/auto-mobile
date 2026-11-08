import type { BootedDevice } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { withDeviceReadinessLock } from "../../utils/deviceReadinessLock";
import { getAbortSignal } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import {
  SimulatorIosPermissionsBackend,
  type IosSimulatorPrivacyClient,
} from "../../utils/ios-cmdline-tools/IosPermissionsBackend";

export type TvosPermissionAction = "grant" | "revoke" | "reset";

export interface TvosPermissionCommandResult {
  permission: string;
  success: boolean;
  /** simctl privacy writes nothing to read back, so a change is never verified on tvOS. */
  verified: false;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface TvosPermissionMutationResult {
  success: boolean;
  changedCount: number;
  failedCount: number;
  results: TvosPermissionCommandResult[];
  error?: string;
}

/**
 * setAppPermissions on an Apple TV simulator (#17527): `simctl privacy <udid> <action> <service>
 * <bundleId>`, captured exiting 0 with no output for `grant photos` and `reset all` on tvOS 26.5.
 * Service names pass through to simctl, which rejects the ones the tvOS runtime lacks. There is no
 * TCC readback on tvOS, so results are never verified.
 */
export class TvosPermissions {
  private readonly backend: SimulatorIosPermissionsBackend;

  constructor(
    private readonly device: Pick<BootedDevice, "deviceId">,
    simctl: IosSimulatorPrivacyClient,
  ) {
    this.backend = new SimulatorIosPermissionsBackend({ deviceId: device.deviceId, simctl });
  }

  async setPermissions(
    action: TvosPermissionAction,
    appId: string,
    permissions: string[],
  ): Promise<TvosPermissionMutationResult> {
    if (resolveIosDeviceKind({ deviceId: this.device.deviceId }) === "physical") {
      return failure(
        "tvOS permission changes use simctl privacy and are only supported on Apple TV simulators",
      );
    }
    if (appId.length === 0) {
      return failure("appId must be a non-empty tvOS bundle identifier");
    }
    if (permissions.length === 0) {
      return { success: true, changedCount: 0, failedCount: 0, results: [] };
    }
    // Same per-device lock as iOS: concurrent simctl privacy calls race on the shared TCC store.
    return withDeviceReadinessLock(
      `ios-privacy:${this.device.deviceId}`,
      () => this.apply(action, appId, permissions),
      { signal: getAbortSignal() },
    );
  }

  private async apply(
    action: TvosPermissionAction,
    appId: string,
    permissions: string[],
  ): Promise<TvosPermissionMutationResult> {
    const results: TvosPermissionCommandResult[] = [];
    for (const permission of permissions) {
      try {
        const output = await this.backend.setPrivacy({ action, permission, appId });
        results.push({
          permission,
          success: true,
          verified: false,
          stdout: output.stdout,
          stderr: output.stderr,
        });
      } catch (error) {
        logger.warn(`tvOS simctl privacy ${action} ${permission} failed`, error);
        results.push({ permission, success: false, verified: false, error: errorMessage(error) });
      }
    }
    const failed = results.filter((result) => !result.success);
    return {
      success: failed.length === 0,
      changedCount: results.length - failed.length,
      failedCount: failed.length,
      results,
      ...(failed.length > 0 ? { error: failed[0].error } : {}),
    };
  }
}

function failure(error: string): TvosPermissionMutationResult {
  return { success: false, changedCount: 0, failedCount: 0, results: [], error };
}
