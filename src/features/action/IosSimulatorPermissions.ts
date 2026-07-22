import { execFile } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";
import type { BootedDevice, ExecResult } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";

export type IosSimulatorPermissionAction = "grant" | "revoke" | "reset";

export interface IosSimulatorPermissionCommandResult {
  permission: string;
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
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
  error?: string;
}

export interface IosSimulatorPermissionState {
  permission: string;
  service: string;
  state: "granted" | "denied" | "unknown" | "limited";
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

export interface IosSimulatorPrivacyClient {
  executeCommandArgs(args: string[], timeoutMs?: number): Promise<ExecResult>;
}

interface TccPermissionRow {
  service: string;
  client: string;
  auth_value?: number | null;
  allowed?: number | null;
  prompt_count?: number | null;
}

interface SqliteColumnInfo {
  name: string;
}

export interface SqliteCommandExecutor {
  execFile(command: string, args: string[]): Promise<{ stdout: string }>;
}

export interface TccPermissionReader {
  readPermissions(deviceId: string, appId: string, permissions?: string[]): Promise<TccPermissionRow[]>;
}

const execFileAsync = promisify(execFile);

class NodeSqliteCommandExecutor implements SqliteCommandExecutor {
  async execFile(command: string, args: string[]): Promise<{ stdout: string }> {
    const { stdout } = await execFileAsync(command, args);
    return { stdout };
  }
}

const TCC_SERVICE_BY_PERMISSION = new Map<string, string>([
  ["calendar", "kTCCServiceCalendar"],
  ["camera", "kTCCServiceCamera"],
  ["contacts", "kTCCServiceAddressBook"],
  ["contacts-limited", "kTCCServiceAddressBook"],
  ["location", "kTCCServiceLocationWhenInUse"],
  ["location-always", "kTCCServiceLocationAlways"],
  ["media-library", "kTCCServiceMediaLibrary"],
  ["microphone", "kTCCServiceMicrophone"],
  ["motion", "kTCCServiceMotion"],
  ["photos", "kTCCServicePhotos"],
  ["photos-add", "kTCCServicePhotosAdd"],
  ["reminders", "kTCCServiceReminders"],
  ["siri", "kTCCServiceSiri"],
]);

export function isIosSimulatorDevice(device: BootedDevice): boolean {
  return isIosSimulatorUdid(device.deviceId);
}

export function normalizePermissions(permissions: string[] | undefined): string[] {
  return (permissions ?? [])
    .map(permission => permission.trim())
    .filter(permission => permission.length > 0);
}

function tccServiceForPermission(permission: string): string {
  return permission.startsWith("kTCCService")
    ? permission
    : TCC_SERVICE_BY_PERMISSION.get(permission) ?? permission;
}

function permissionForTccService(service: string): string {
  for (const [permission, tccService] of TCC_SERVICE_BY_PERMISSION) {
    if (tccService === service) {
      return permission;
    }
  }
  return service;
}

function stateFromAuthValue(value: number | null | undefined): IosSimulatorPermissionState["state"] {
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

export class SqliteTccPermissionReader implements TccPermissionReader {
  constructor(
    private readonly sqlite: SqliteCommandExecutor = new NodeSqliteCommandExecutor(),
    private readonly homeDirectory: string = homedir()
  ) {}

  async readPermissions(deviceId: string, appId: string, permissions?: string[]): Promise<TccPermissionRow[]> {
    const tccPath = join(
      this.homeDirectory,
      "Library",
      "Developer",
      "CoreSimulator",
      "Devices",
      deviceId,
      "data",
      "Library",
      "TCC",
      "TCC.db"
    );
    const services = permissions && permissions.length > 0
      ? permissions.map(tccServiceForPermission)
      : [];
    const serviceFilter = services.length > 0
      ? ` and service in (${services.map(service => `'${service.replace(/'/g, "''")}'`).join(",")})`
      : "";
    const columns = await this.readAccessColumns(tccPath);
    const optionalColumns = ["auth_value", "allowed", "prompt_count"]
      .filter(column => columns.has(column));
    const selectColumns = ["service", "client", ...optionalColumns].join(", ");
    const query = [
      `select ${selectColumns}`,
      "from access",
      `where client = '${appId.replace(/'/g, "''")}'${serviceFilter};`
    ].join("\n");

    const { stdout } = await this.sqlite.execFile("sqlite3", ["-json", tccPath, query]);
    return JSON.parse(stdout.trim() || "[]") as TccPermissionRow[];
  }

  private async readAccessColumns(tccPath: string): Promise<Set<string>> {
    const { stdout } = await this.sqlite.execFile("sqlite3", ["-json", tccPath, "pragma table_info(access);"]);
    const columns = JSON.parse(stdout.trim() || "[]") as SqliteColumnInfo[];
    return new Set(columns.map(column => column.name));
  }
}

export class IosSimulatorPermissions {
  private device: BootedDevice;
  private simctl: IosSimulatorPrivacyClient;
  private tccReader: TccPermissionReader;

  constructor(
    device: BootedDevice,
    simctl: IosSimulatorPrivacyClient | null = null,
    tccReader: TccPermissionReader | null = null
  ) {
    this.device = device;
    this.simctl = simctl || new SimCtlClient(device);
    this.tccReader = tccReader || new SqliteTccPermissionReader();
  }

  async setPermissions(
    action: IosSimulatorPermissionAction,
    appId: string,
    permissions: string[]
  ): Promise<IosSimulatorPermissionMutationResult> {
    const normalizedAppId = appId.trim();
    const normalizedPermissions = normalizePermissions(permissions);

    if (this.device.platform !== "ios") {
      return this.mutationFailure(action, normalizedAppId, "iOS simulator permissions are only supported on iOS simulators");
    }

    if (!isIosSimulatorDevice(this.device)) {
      return this.mutationFailure(action, normalizedAppId, "iOS permission changes via simctl privacy are only supported on simulators");
    }

    if (!normalizedAppId) {
      return this.mutationFailure(action, normalizedAppId, "appId must be a non-empty iOS bundle identifier");
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
        results: []
      };
    }

    const results: IosSimulatorPermissionCommandResult[] = await Promise.all(
      normalizedPermissions.map(async permission => {
        try {
          const result = await this.simctl.executeCommandArgs([
            "privacy",
            this.device.deviceId,
            action,
            permission,
            normalizedAppId
          ]);
          return { permission, success: true, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          return {
            permission,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );

    const failedCount = results.filter(result => !result.success).length;

    return {
      success: failedCount === 0,
      appId: normalizedAppId,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      action,
      changedCount: results.length - failedCount,
      failedCount,
      results,
      ...(failedCount > 0 ? { error: `One or more iOS simulator permissions failed to ${action}` } : {})
    };
  }

  async getPermissions(appId: string, permissions?: string[]): Promise<IosSimulatorPermissionQueryResult> {
    const normalizedAppId = appId.trim();
    const normalizedPermissions = permissions ? normalizePermissions(permissions) : undefined;

    if (this.device.platform !== "ios") {
      return this.queryFailure(normalizedAppId, "iOS simulator permission queries are only supported on iOS simulators");
    }

    if (!isIosSimulatorDevice(this.device)) {
      return this.queryFailure(normalizedAppId, "iOS permission queries are only supported on simulators");
    }

    if (!normalizedAppId) {
      return this.queryFailure(normalizedAppId, "appId must be a non-empty iOS bundle identifier");
    }

    try {
      const rows = await this.tccReader.readPermissions(this.device.deviceId, normalizedAppId, normalizedPermissions);
      const rowByService = new Map(rows.map(row => [row.service, row]));
      const queriedServices = normalizedPermissions && normalizedPermissions.length > 0
        ? normalizedPermissions.map(tccServiceForPermission)
        : rows.map(row => row.service);
      const uniqueServices = [...new Set(queriedServices)];

      return {
        success: true,
        appId: normalizedAppId,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        permissions: uniqueServices.map(service => {
          const row = rowByService.get(service);
          const authValue = row?.auth_value ?? null;
          const allowed = row?.allowed ?? null;
          const state = authValue !== null ? stateFromAuthValue(authValue) : stateFromAllowed(allowed);
          const authValueForResult = authValue ?? allowed;
          return {
            permission: permissionForTccService(service),
            service,
            state,
            ...(authValueForResult === null ? {} : { authValue: authValueForResult }),
            ...(row ? { raw: row as Record<string, string | number | null> } : {})
          };
        })
      };
    } catch (error) {
      return this.queryFailure(normalizedAppId, error instanceof Error ? error.message : String(error));
    }
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
      platform: this.device.platform,
      action,
      changedCount: 0,
      failedCount: 0,
      results: [],
      error
    };
  }

  private queryFailure(appId: string, error: string): IosSimulatorPermissionQueryResult {
    return {
      success: false,
      appId,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      permissions: [],
      error
    };
  }
}
