import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { errorMessage } from "../../utils/describeUnknownError";
import type { BootedDevice } from "../../models";
import {
  SimulatorTccSqliteClient,
  permissionForTccService,
  tccServiceForPermission,
  type TccPermissionReader,
  type TccPermissionRow,
} from "../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import {
  resolveIosPermissionsBackend,
  type IosPermissionsBackend,
  type IosSimulatorPrivacyClient,
} from "../../utils/ios-cmdline-tools/IosPermissionsBackend";
import { withDeviceReadinessLock } from "../../utils/deviceReadinessLock";
import { getAbortSignal } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";

export type IosSimulatorPermissionAction = "grant" | "revoke" | "reset";

export interface IosSimulatorPermissionCommandResult {
  permission: string;
  success: boolean;
  applied?: boolean;
  verified?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  warning?: string;
}

export interface IosSimulatorPermissionMutationResult {
  success: boolean;
  appId: string;
  deviceId: string;
  platform: "android" | "ios";
  action: IosSimulatorPermissionAction;
  changedCount: number;
  failedCount: number;
  results: IosSimulatorPermissionCommandResult[];
  warnings?: string[];
  error?: string;
}

export interface IosSimulatorPermissionState {
  permission: string;
  service: string;
  state: "granted" | "denied" | "unknown" | "limited";
  verified?: boolean;
  reason?: string;
  accessLevel?: "readWrite" | "addOnly";
  evidence?: "storedTccGrant";
  authValue?: number;
  raw?: Record<string, string | number | null>;
}

export interface IosSimulatorPermissionQueryResult {
  success: boolean;
  appId: string;
  deviceId: string;
  platform: "android" | "ios";
  permissions: IosSimulatorPermissionState[];
  error?: string;
}

export { type IosSimulatorPrivacyClient } from "../../utils/ios-cmdline-tools/IosPermissionsBackend";

export { type TccPermissionReader } from "../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";

export function isIosSimulatorDevice(device: BootedDevice): boolean {
  return resolveIosDeviceKind({ deviceId: device.deviceId }) === "simulator";
}

export function normalizePermissions(permissions: string[] | undefined): string[] {
  return (permissions ?? [])
    .map((permission) => permission.trim())
    .filter((permission) => permission.length > 0);
}

function stateFromAuthValue(
  value: number | null | undefined,
): IosSimulatorPermissionState["state"] {
  if (value === 2) {
    return "granted";
  }
  if (value === 0) {
    return "denied";
  }
  if (value === 3) {
    return "limited";
  }
  return "unknown";
}

// Legacy TCC schema uses `allowed` (0/1) instead of `auth_value` (0/2/3).
function stateFromAllowed(value: number | null | undefined): IosSimulatorPermissionState["state"] {
  if (value === 1) {
    return "granted";
  }
  if (value === 0) {
    return "denied";
  }
  return "unknown";
}

/** Classify stored TCC state without claiming host verification of Photos access. */
export function classifyIosSimulatorPermission(
  service: string,
  row?: TccPermissionRow,
): Pick<IosSimulatorPermissionState, "state" | "verified" | "reason" | "accessLevel" | "evidence"> {
  const authValue = row?.auth_value ?? null;
  const state = authValue !== null ? stateFromAuthValue(authValue) : stateFromAllowed(row?.allowed);
  const accessLevel =
    service === "kTCCServicePhotos"
      ? "readWrite"
      : service === "kTCCServicePhotosAdd"
        ? "addOnly"
        : undefined;
  if (service === "kTCCServicePhotos" && state === "granted") {
    return {
      state: "unknown",
      verified: false,
      accessLevel,
      evidence: "storedTccGrant",
      reason:
        "stored TCC grant for Photos does not establish effective full read/write authorization; native PHPhotoLibrary status is not observable from the host without app instrumentation",
    };
  }
  return { state, ...(accessLevel === undefined ? {} : { accessLevel }) };
}

const PHOTOS_GRANT_UNVERIFIED_WARNING =
  "Photos grant was dispatched via simctl but effective full read/write Photos access could not be verified; add-only is insufficient; verify by launching the app and checking PHPhotoLibrary authorizationStatusForAccessLevel:ReadWrite";

export class IosSimulatorPermissions {
  private device: BootedDevice;
  private readonly backend: IosPermissionsBackend;
  private tccReader: TccPermissionReader;

  constructor(
    device: BootedDevice,
    simctl: IosSimulatorPrivacyClient | null = null,
    tccReader: TccPermissionReader | null = null,
    private readonly withPrivacyLock: typeof withDeviceReadinessLock = withDeviceReadinessLock,
  ) {
    this.device = device;
    this.backend = resolveIosPermissionsBackend({
      deviceId: device.deviceId,
      simctl: simctl || new SimCtlClient(device),
    });
    this.tccReader = tccReader || new SimulatorTccSqliteClient();
  }

  async setPermissions(
    action: IosSimulatorPermissionAction,
    appId: string,
    permissions: string[],
  ): Promise<IosSimulatorPermissionMutationResult> {
    const normalizedAppId = appId.trim();
    const normalizedPermissions = normalizePermissions(permissions);

    if (this.device.platform !== "ios") {
      return this.mutationFailure(
        action,
        normalizedAppId,
        "iOS simulator permissions are only supported on iOS simulators",
      );
    }

    if (this.backend.kind === "physical") {
      return this.mutationFailure(
        action,
        normalizedAppId,
        "iOS permission changes via simctl privacy are only supported on simulators",
      );
    }

    if (!normalizedAppId) {
      return this.mutationFailure(
        action,
        normalizedAppId,
        "appId must be a non-empty iOS bundle identifier",
      );
    }

    if (normalizedPermissions.length === 0) {
      return {
        success: true,
        appId: normalizedAppId,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        action,
        changedCount: 0,
        failedCount: 0,
        results: [],
      };
    }

    return this.withPrivacyLock(
      `ios-privacy:${this.device.deviceId}`,
      () => this.applyPermissions(action, normalizedAppId, normalizedPermissions),
      { signal: getAbortSignal() },
    );
  }

  private async applyPermissions(
    action: IosSimulatorPermissionAction,
    normalizedAppId: string,
    normalizedPermissions: string[],
  ): Promise<IosSimulatorPermissionMutationResult> {
    // Serialized across instances and batches: concurrent `simctl privacy` invocations for
    // the same device/app race each other against the simulator's shared
    // TCC.db and against simctl's own app-relaunch side effect, producing
    // spurious per-permission failures (issue #6581). One permission's grant
    // must fully apply before the next one starts.
    const results: IosSimulatorPermissionCommandResult[] = [];
    for (const permission of normalizedPermissions) {
      try {
        const result = await this.backend.setPrivacy({
          action,
          permission,
          appId: normalizedAppId,
        });
        const verification =
          action === "grant" &&
          (permission === "all" || tccServiceForPermission(permission) === "kTCCServicePhotos")
            ? await this.verifyPhotosGrant(
                normalizedAppId,
                permission === "all" ? "photos" : permission,
              )
            : { success: true };
        results.push({ permission, ...verification, stdout: result.stdout, stderr: result.stderr });
      } catch (error) {
        logger.warn("iOS simulator permission command failed", error);
        results.push({
          permission,
          success: false,
          error: errorMessage(error),
        });
      }
    }

    const failedCount = results.filter((result) => !result.success).length;
    const commandError = results.find(
      (result) => !result.success && result.verified !== false,
    )?.error;
    const warnings = results.flatMap((result) => (result.warning ? [result.warning] : []));

    return {
      success: failedCount === 0,
      appId: normalizedAppId,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      action,
      changedCount: results.length - failedCount,
      failedCount,
      results,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(failedCount > 0
        ? {
            error: commandError ?? `One or more iOS simulator permissions failed to ${action}`,
          }
        : {}),
    };
  }

  private async verifyPhotosGrant(
    appId: string,
    permission: string,
  ): Promise<
    Pick<IosSimulatorPermissionCommandResult, "success" | "applied" | "verified" | "warning">
  > {
    const unverified = {
      success: true,
      applied: true,
      verified: false,
      warning: PHOTOS_GRANT_UNVERIFIED_WARNING,
    };
    try {
      const rows = await this.tccReader.readPermissions(this.device.deviceId, appId, [permission]);
      const classification = classifyIosSimulatorPermission(
        "kTCCServicePhotos",
        rows.find((row) => row.service === "kTCCServicePhotos"),
      );
      // Success is intentionally unreachable until app-level instrumentation supplies a
      // verified native status; this branch is the seam for that verification.
      if (classification.state === "granted" && classification.verified !== false) {
        return { success: true, applied: true, verified: true };
      }
    } catch (error) {
      logger.warn("iOS simulator Photos grant readback failed", error);
      return unverified;
    }
    return unverified;
  }

  async getPermissions(
    appId: string,
    permissions?: string[],
  ): Promise<IosSimulatorPermissionQueryResult> {
    const normalizedAppId = appId.trim();
    const normalizedPermissions = permissions ? normalizePermissions(permissions) : undefined;

    if (this.device.platform !== "ios") {
      return this.queryFailure(
        normalizedAppId,
        "iOS simulator permission queries are only supported on iOS simulators",
      );
    }

    if (this.backend.kind === "physical") {
      return this.queryFailure(
        normalizedAppId,
        "iOS permission queries are only supported on simulators",
      );
    }

    if (!normalizedAppId) {
      return this.queryFailure(normalizedAppId, "appId must be a non-empty iOS bundle identifier");
    }

    try {
      const rows = await this.tccReader.readPermissions(
        this.device.deviceId,
        normalizedAppId,
        normalizedPermissions,
      );
      const rowByService = new Map(rows.map((row) => [row.service, row]));
      const queriedServices =
        normalizedPermissions && normalizedPermissions.length > 0
          ? normalizedPermissions.map(tccServiceForPermission)
          : rows.map((row) => row.service);
      const uniqueServices = [...new Set(queriedServices)];

      return {
        success: true,
        appId: normalizedAppId,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        permissions: uniqueServices.map((service) => {
          const row = rowByService.get(service);
          const authValue = row?.auth_value ?? null;
          const allowed = row?.allowed ?? null;
          const classification = classifyIosSimulatorPermission(service, row);
          const authValueForResult = authValue ?? allowed;
          return {
            permission: permissionForTccService(service),
            service,
            ...classification,
            ...(authValueForResult === null ? {} : { authValue: authValueForResult }),
            ...(row ? { raw: row } : {}),
          };
        }),
      };
    } catch (error) {
      logger.warn("iOS simulator permission readback failed", error);
      return this.queryFailure(normalizedAppId, errorMessage(error));
    }
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
      platform: this.device.platform,
      action,
      changedCount: 0,
      failedCount: 0,
      results: [],
      error,
    };
  }

  private queryFailure(appId: string, error: string): IosSimulatorPermissionQueryResult {
    return {
      success: false,
      appId,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      permissions: [],
      error,
    };
  }
}
