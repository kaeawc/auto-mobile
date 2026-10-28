import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { errorMessage } from "../../utils/describeUnknownError";
import type { AndroidOrIosPlatform, BootedDevice } from "../../models";
import { requireAndroidOrIosPlatform } from "../../models";
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
import { parseIosMajorVersion } from "../../utils/ios-cmdline-tools/iosVersion";
import { UnobservablePhotosAuthorizationVerifier } from "./UnobservablePhotosAuthorizationVerifier";

/** ORCHESTRATOR-CHOSEN: 27.0 is the only captured runtime showing this inference; 26.5 does not. */
export const IMPLIED_ADD_ONLY_MIN_IOS_MAJOR = 27;

export type IosSimulatorPermissionAction = "grant" | "revoke" | "reset";

export type PhotosAuthorizationStatus =
  | "authorized"
  | "limited"
  | "denied"
  | "notDetermined"
  | "addOnly"
  | "unobservable";

export interface PhotosAuthorizationVerifier {
  verifyReadWrite(deviceId: string, appId: string): Promise<PhotosAuthorizationStatus>;
}

export interface IosSimulatorPermissionCommandResult {
  permission: string;
  success: boolean;
  applied?: boolean;
  verified?: boolean;
  code?: "PHOTOS_FULL_ACCESS_UNVERIFIED" | "PHOTOS_FULL_ACCESS_NOT_ESTABLISHED";
  accessLevel?: "readWrite" | "addOnly";
  evidence?: "storedTccGrant";
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
  evidence?: "storedTccGrant" | "impliedByFullPhotosGrant";
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

/** photos-add readback also needs the sibling Photos row to detect an implied full grant. */
function withSiblingPhotosRead(permissions: string[] | undefined): string[] | undefined {
  const services = permissions?.map(tccServiceForPermission);
  return permissions &&
    services?.includes("kTCCServicePhotosAdd") &&
    !services.includes("kTCCServicePhotos")
    ? [...permissions, "photos"]
    : permissions;
}

const PHOTOS_ACCESS_LEVELS = new Map<string, "readWrite" | "addOnly">([
  ["kTCCServicePhotos", "readWrite"],
  ["kTCCServicePhotosAdd", "addOnly"],
]);

function hasImpliedPhotosAddGrant(
  service: string,
  state: IosSimulatorPermissionState["state"],
  photosRow: TccPermissionRow | undefined,
  iosMajor: number | null | undefined,
): boolean {
  return (
    service === "kTCCServicePhotosAdd" &&
    state !== "granted" &&
    photosRow?.auth_value === 2 &&
    iosMajor !== null &&
    iosMajor !== undefined &&
    iosMajor >= IMPLIED_ADD_ONLY_MIN_IOS_MAJOR
  );
}

/**
 * Classify stored TCC state without claiming host verification of Photos access.
 * photosRow supplies the sibling kTCCServicePhotos row for add-only inference.
 */
export function classifyIosSimulatorPermission(
  service: string,
  row?: TccPermissionRow,
  photosRow?: TccPermissionRow,
  iosMajor?: number | null,
): Pick<IosSimulatorPermissionState, "state" | "verified" | "reason" | "accessLevel" | "evidence"> {
  const authValue = row?.auth_value ?? null;
  const state = authValue !== null ? stateFromAuthValue(authValue) : stateFromAllowed(row?.allowed);
  const accessLevel = PHOTOS_ACCESS_LEVELS.get(service);
  if (hasImpliedPhotosAddGrant(service, state, photosRow, iosMajor)) {
    return {
      state: "granted",
      verified: false,
      accessLevel,
      evidence: "impliedByFullPhotosGrant",
      reason:
        "add-only access is implied by the full kTCCServicePhotos grant; the stored kTCCServicePhotosAdd row, if present, is stale and not authoritative",
    };
  }
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
  private readonly iosMajor: number | null;
  private readonly backend: IosPermissionsBackend;
  private tccReader: TccPermissionReader;

  constructor(
    device: BootedDevice,
    simctl: IosSimulatorPrivacyClient | null = null,
    tccReader: TccPermissionReader | null = null,
    private readonly withPrivacyLock: typeof withDeviceReadinessLock = withDeviceReadinessLock,
    private readonly photosVerifier: PhotosAuthorizationVerifier = new UnobservablePhotosAuthorizationVerifier(),
  ) {
    this.device = device;
    this.iosMajor = parseIosMajorVersion(device.iosVersion ?? device.osVersion);
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
            ? await this.verifyPhotosGrant(normalizedAppId)
            : { success: true };
        if (permission === "all" && !verification.success) {
          results.push({
            permission,
            success: true,
            applied: true,
            stdout: result.stdout,
            stderr: result.stderr,
          });
          results.push({ permission: "photos", ...verification });
          continue;
        }
        results.push({
          permission,
          ...verification,
          ...(tccServiceForPermission(permission) === "kTCCServicePhotosAdd"
            ? { accessLevel: "addOnly" as const }
            : {}),
          stdout: result.stdout,
          stderr: result.stderr,
        });
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
    const firstError = results.find((result) => !result.success)?.error;
    const warnings = results.flatMap((result) => (result.warning ? [result.warning] : []));

    return {
      success: failedCount === 0,
      appId: normalizedAppId,
      deviceId: this.device.deviceId,
      platform: this.reportedPlatform(),
      action,
      changedCount: results.length - failedCount,
      failedCount,
      results,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(failedCount > 0 ? { error: firstError } : {}),
    };
  }

  private async verifyPhotosGrant(
    appId: string,
  ): Promise<Omit<IosSimulatorPermissionCommandResult, "permission">> {
    const unverified: Omit<IosSimulatorPermissionCommandResult, "permission"> = {
      success: true,
      applied: true,
      verified: false,
      accessLevel: "readWrite",
      code: "PHOTOS_FULL_ACCESS_UNVERIFIED",
      warning: PHOTOS_GRANT_UNVERIFIED_WARNING,
    };
    let evidence: IosSimulatorPermissionCommandResult["evidence"];
    try {
      const rows = await this.tccReader.readPermissions(this.device.deviceId, appId, ["photos"]);
      const classification = classifyIosSimulatorPermission(
        "kTCCServicePhotos",
        rows.find((row) => row.service === "kTCCServicePhotos"),
      );
      evidence = classification.evidence === "storedTccGrant" ? classification.evidence : undefined;
    } catch (error) {
      logger.warn(`iOS simulator Photos grant readback failed: ${errorMessage(error)}`, error);
      // Missing stored-grant evidence only; the native verifier below stays authoritative.
    }

    let status: PhotosAuthorizationStatus = "unobservable";
    try {
      status = await this.photosVerifier.verifyReadWrite(this.device.deviceId, appId);
    } catch (error) {
      logger.warn(
        `iOS simulator Photos authorization verification failed: ${errorMessage(error)}`,
        error,
      );
    }
    const metadata = {
      applied: true,
      accessLevel: "readWrite" as const,
      ...(evidence ? { evidence } : {}),
    };
    if (status === "authorized") {
      return { ...metadata, success: true, verified: true };
    }
    if (status === "unobservable") {
      return { ...unverified, ...metadata };
    }
    return {
      ...metadata,
      success: false,
      verified: false,
      code: "PHOTOS_FULL_ACCESS_NOT_ESTABLISHED",
      error: `Photos grant was dispatched via simctl but effective full read/write Photos access was not established (observed ${status}); add-only is insufficient; launch the app and check PHPhotoLibrary authorizationStatusForAccessLevel:ReadWrite`,
    };
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
        withSiblingPhotosRead(normalizedPermissions),
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
          const classification = classifyIosSimulatorPermission(
            service,
            row,
            rowByService.get("kTCCServicePhotos"),
            this.iosMajor,
          );
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

  /** The device's platform for a result; a watch is rejected rather than reported as a phone. */
  private reportedPlatform(): AndroidOrIosPlatform {
    return requireAndroidOrIosPlatform(this.device.platform, "Managing app permissions");
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
      platform: this.reportedPlatform(),
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
      platform: this.reportedPlatform(),
      permissions: [],
      error,
    };
  }
}
