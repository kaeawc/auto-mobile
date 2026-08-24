import { errorMessage } from "../describeUnknownError";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ActionableError } from "../../models/ActionableError";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../HostCommandExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";
import { isIosSimulatorUdid } from "./iosDeviceType";

const DEFAULT_TCC_QUERY_TIMEOUT_MS = 5_000;
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

export interface TccPermissionRow {
  service: string;
  client: string;
  auth_value?: number | null;
  allowed?: number | null;
  prompt_count?: number | null;
}

export interface TccPermissionReader {
  readPermissions(
    deviceId: string,
    appId: string,
    permissions?: string[],
    signal?: AbortSignal,
  ): Promise<TccPermissionRow[]>;
}

export interface TccDatabaseFileSystem {
  stat(path: string): Promise<{ isFile(): boolean }>;
}

export interface SimulatorTccSqliteClientDependencies {
  executor?: HostCommandExecutor;
  fileSystem?: TccDatabaseFileSystem;
  homeDirectory?: string;
  timer?: Timer;
  timeoutMs?: number;
}

const nodeFileSystem: TccDatabaseFileSystem = { stat };

export function tccServiceForPermission(permission: string): string {
  return permission.startsWith("kTCCService")
    ? permission
    : (TCC_SERVICE_BY_PERMISSION.get(permission) ?? permission);
}

function sqliteParameterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseJsonArray(output: string, context: string): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(output.trim() || "[]");
    if (
      !Array.isArray(parsed) ||
      parsed.some((row) => row === null || typeof row !== "object" || Array.isArray(row))
    ) {
      throw new Error("expected an array of JSON objects");
    }
    return parsed as Array<Record<string, unknown>>;
  } catch (error) {
    const detail = errorMessage(error);
    throw new ActionableError(
      `sqlite3 returned malformed JSON while reading ${context}: ${detail}`,
    );
  }
}

function sqliteErrorDetail(error: unknown): string {
  return errorMessage(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function optionalNumberField(
  row: Record<string, unknown>,
  field: "auth_value" | "allowed" | "prompt_count",
): Pick<TccPermissionRow, typeof field> {
  const value = row[field];
  return typeof value === "number" || value === null ? { [field]: value } : {};
}

function parsePermissionRows(output: string, deviceId: string): TccPermissionRow[] {
  return parseJsonArray(output, `simulator TCC database for ${deviceId}`).map((row) => {
    if (typeof row.service !== "string" || typeof row.client !== "string") {
      throw new ActionableError(
        `sqlite3 returned a TCC permission row without service and client for ${deviceId}`,
      );
    }
    return {
      service: row.service,
      client: row.client,
      ...optionalNumberField(row, "auth_value"),
      ...optionalNumberField(row, "allowed"),
      ...optionalNumberField(row, "prompt_count"),
    };
  });
}

/**
 * The sole production owner of simulator TCC sqlite3 calls. It keeps the
 * database path, argv construction, schema handling, timeout, and error
 * classification together so permission actions never invoke sqlite directly.
 */
export class SimulatorTccSqliteClient implements TccPermissionReader {
  private readonly executor: HostCommandExecutor;
  private readonly fileSystem: TccDatabaseFileSystem;
  private readonly homeDirectory: string;
  private readonly timer: Timer;
  private readonly timeoutMs: number;

  constructor(dependencies: SimulatorTccSqliteClientDependencies = {}) {
    this.executor = dependencies.executor ?? new DefaultHostCommandExecutor();
    this.fileSystem = dependencies.fileSystem ?? nodeFileSystem;
    this.homeDirectory = dependencies.homeDirectory ?? homedir();
    this.timer = dependencies.timer ?? defaultTimer;
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TCC_QUERY_TIMEOUT_MS;
  }

  async readPermissions(
    deviceId: string,
    appId: string,
    permissions?: string[],
    signal?: AbortSignal,
  ): Promise<TccPermissionRow[]> {
    const databasePath = await this.resolveDatabasePath(deviceId);
    const columns = await this.readAccessColumns(databasePath, deviceId, signal);
    const requiredColumns = ["service", "client"].filter((column) => !columns.has(column));
    if (requiredColumns.length > 0) {
      throw new ActionableError(
        `Simulator TCC database for ${deviceId} is incompatible: missing required access columns: ${requiredColumns.join(", ")}`,
      );
    }

    const optionalColumns = ["auth_value", "allowed", "prompt_count"].filter((column) =>
      columns.has(column),
    );
    const services = (permissions ?? []).map(tccServiceForPermission);
    const parameterArgs = [
      "-cmd",
      ".parameter init",
      "-cmd",
      `.parameter set :appId ${sqliteParameterValue(appId)}`,
      ...services.flatMap((service, index) => [
        "-cmd",
        `.parameter set :service${index} ${sqliteParameterValue(service)}`,
      ]),
    ];
    const serviceFilter =
      services.length > 0
        ? ` and service in (${services.map((_service, index) => `:service${index}`).join(", ")})`
        : "";
    const query = [
      `select ${["service", "client", ...optionalColumns].join(", ")}`,
      "from access",
      `where client = :appId${serviceFilter};`,
    ].join("\n");
    const result = await this.execute(
      ["-json", ...parameterArgs, databasePath, query],
      databasePath,
      deviceId,
      signal,
    );
    return parsePermissionRows(result.stdout, deviceId);
  }

  private async resolveDatabasePath(deviceId: string): Promise<string> {
    const normalizedDeviceId = deviceId.trim();
    if (!normalizedDeviceId) {
      throw new ActionableError("Simulator TCC database lookup requires a non-empty device UDID");
    }
    if (!isIosSimulatorUdid(normalizedDeviceId)) {
      throw new ActionableError(
        `Simulator TCC database lookup requires a simulator UDID, received ${normalizedDeviceId}`,
      );
    }
    const databasePath = join(
      this.homeDirectory,
      "Library",
      "Developer",
      "CoreSimulator",
      "Devices",
      normalizedDeviceId,
      "data",
      "Library",
      "TCC",
      "TCC.db",
    );
    try {
      const details = await this.fileSystem.stat(databasePath);
      if (!details.isFile()) {
        throw new ActionableError(
          `Simulator TCC database is unavailable for ${normalizedDeviceId}: ${databasePath} is not a file`,
        );
      }
      return databasePath;
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(
        `Simulator TCC database is unavailable for ${normalizedDeviceId}: ${databasePath} (${sqliteErrorDetail(error)})`,
      );
    }
  }

  private async readAccessColumns(
    databasePath: string,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const result = await this.execute(
      ["-json", databasePath, "pragma table_info(access);"],
      databasePath,
      deviceId,
      signal,
    );
    const rows = parseJsonArray(result.stdout, `simulator TCC database for ${deviceId}`);
    return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
  }

  private async execute(
    args: string[],
    databasePath: string,
    deviceId: string,
    parentSignal?: AbortSignal,
  ) {
    const controller = new AbortController();
    let timedOut = false;
    const cancelFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      cancelFromParent();
    } else {
      parentSignal?.addEventListener("abort", cancelFromParent, { once: true });
    }
    const timeout = this.timer.setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("simulator TCC query timed out"));
    }, this.timeoutMs);

    try {
      return await this.executor.executeCommand("sqlite3", args, { signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new ActionableError(
          `Timed out after ${this.timeoutMs}ms while reading simulator TCC database for ${deviceId}`,
        );
      }
      if (parentSignal?.aborted) {
        throw new ActionableError(`Reading simulator TCC database for ${deviceId} was cancelled`);
      }
      const detail = sqliteErrorDetail(error);
      if (hasErrorCode(error, "ENOENT") || /\bENOENT\b|spawn sqlite3/i.test(detail)) {
        throw new ActionableError(
          "sqlite3 is unavailable; install the macOS SQLite command-line tool and retry",
        );
      }
      if (/file is not a database|malformed database/i.test(detail)) {
        throw new ActionableError(
          `Simulator TCC database is malformed for ${deviceId}: ${databasePath}`,
        );
      }
      throw new ActionableError(`Failed to read simulator TCC database for ${deviceId}: ${detail}`);
    } finally {
      this.timer.clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", cancelFromParent);
    }
  }
}
