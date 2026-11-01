import { ActionableError, BootedDevice, Platform, type ExecResult } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import { type AppFileFileSystem, type AppFileStats } from "./appFileService";
import { promises as nodeFs } from "node:fs";
import { sortedReaddirEntries } from "../utils/io";
import {
  AppContainersTarget,
  AppFileContainer,
  AppFileListEntry,
  PutAppFileTarget,
  buildAppFileResourceUri,
  normalizeAppFileRelativePath,
} from "./appFileContract";
import * as hostPath from "node:path";
import { basename, dirname, join, posix } from "node:path";
import { logger } from "../utils/logger";
import { findBootedDeviceForResource } from "./resourceDeviceResolver";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { type AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { TextDecoder } from "node:util";

export const APP_FILE_STAGING_CLEANUP_COMMAND_TIMEOUT_MS = 5000;

/** Printed by the write script only when it saved the previous content of an overwritten file. */
export const APP_FILE_BACKUP_MARKER = "AUTOMOBILE_APP_FILE_BACKUP";

/** Printed (to stderr) by the write script when the destination is an existing directory. */
export const APP_FILE_DIRECTORY_MARKER = "AUTOMOBILE_APP_FILE_DESTINATION_IS_DIRECTORY";

/** Backups removed per device command, matching the other batched file commands. */
export const APP_FILE_BACKUP_DISCARD_CHUNK = 64;

/** Maps the write script's directory-guard failure to an actionable error, else `undefined`. */
export function directoryDestinationError(
  error: unknown,
  destinationPath: string,
  appId: string,
): ActionableError | undefined {
  if (!errorMessage(error).includes(APP_FILE_DIRECTORY_MARKER)) {
    return undefined;
  }
  return new ActionableError(
    `Cannot write ${destinationPath} for ${appId}: the destination is an existing directory. ` +
      "Choose a file path (for example a name inside that directory).",
  );
}

export function batchWarning(warnings: Array<string | undefined>): { warning?: string } {
  const unique = [...new Set(warnings.filter((warning): warning is string => !!warning))];
  return unique.length > 0 ? { warning: unique.join(" ") } : {};
}

export function leftoverBackupsWarning(paths: string[]): string {
  return `The write succeeded, but these hidden backups of overwritten files could not be removed: ${paths.join(", ")}.`;
}

export const nodeAppFileFileSystem: AppFileFileSystem = {
  stat: async (path) => nodeFs.stat(path),
  lstat: async (path) => nodeFs.lstat(path),
  readdir: async (path) => sortedReaddirEntries(path),
  mkdir: async (path) => {
    await nodeFs.mkdir(path, { recursive: true });
  },
  copyFile: async (sourcePath, destinationPath) => {
    await nodeFs.copyFile(sourcePath, destinationPath);
  },
  rename: async (oldPath, newPath) => {
    await nodeFs.rename(oldPath, newPath);
  },
  readFileBuffer: async (path) => nodeFs.readFile(path),
  writeFileBuffer: async (path, data) => {
    await nodeFs.writeFile(path, data);
  },
  mkdtemp: async (prefix) => nodeFs.mkdtemp(prefix),
  rm: async (path) => {
    await nodeFs.rm(path, { recursive: true, force: true });
  },
};

export const ANDROID_APP_FILE_MAX_BUFFER = 64 * 1024 * 1024;

export function requireAppContainersTarget(target: PutAppFileTarget): AppContainersTarget {
  if (target.domain !== "app_containers") {
    throw new ActionableError(
      `app-container provider received unsupported target domain: ${target.domain}`,
    );
  }
  return target;
}

export function iosAtomicTemporaryPath(target: string, index: number): string {
  return join(dirname(target), `.${basename(target)}.${index}.tmp`);
}

/** Shared atomic copy; callers retain their own ordering and temporary-file sequence. */
export async function writeIosFileAtomically(
  fileSystem: AppFileFileSystem,
  sourcePath: string,
  target: string,
  index: number,
): Promise<void> {
  const temporary = iosAtomicTemporaryPath(target, index);
  try {
    await fileSystem.mkdir(dirname(target));
    await fileSystem.copyFile(sourcePath, temporary);
    await fileSystem.rename(temporary, target);
  } catch (error) {
    try {
      await fileSystem.rm(temporary);
    } catch (cleanupError) {
      logger.warn(
        `Failed to remove partial iOS app file at ${temporary}: ${errorMessage(cleanupError)}`,
        cleanupError,
      );
    }
    // Preserve the original write error for callers and existing provider contracts.
    throw error;
  }
}

export async function findBootedDevice(deviceId: string): Promise<BootedDevice> {
  const device = await findBootedDeviceForResource(deviceId, "AppFileService");
  if (!device) {
    throw new ActionableError(`Device not found or not booted: ${deviceId}`);
  }
  return device;
}

export function normalizeAppId(appId: string): string {
  const normalized = appId.trim();
  const segments = normalized.split(".");
  if (
    normalized.length === 0 ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ActionableError(
      "appId must be a non-empty app identifier without path separators or traversal segments.",
    );
  }
  return normalized;
}

export function unsupportedAppFileOperation(
  operation: string,
  platform: Platform,
  appId: string,
  { container, reason }: { container: AppFileContainer; reason: string },
): ActionableError {
  return new ActionableError(
    `${operation} is not supported for appId ${appId} in ${container} on ${platform}: ${reason}`,
  );
}

export type AndroidTarget =
  | { kind: "runAs"; relativePath: string }
  | { kind: "external"; absolutePath: string }
  | { kind: "unsupported"; message: string };

export function resolveAndroidTarget(
  appId: string,
  container: AppFileContainer,
  path: string,
  userId = 0,
): AndroidTarget {
  const safePath = normalizeAppFileRelativePath(path);
  switch (container) {
    case "documents":
      return { kind: "runAs", relativePath: posix.join("files", safePath) };
    case "cache":
      return { kind: "runAs", relativePath: posix.join("cache", safePath) };
    case "tmp":
      return { kind: "runAs", relativePath: posix.join("cache", "tmp", safePath) };
    case "externalFiles":
      // Preserve verified user-0 argv. Unverified, from Android scoped-storage
      // documentation: on API 30+, shell read/list access to other apps' Android/data
      // directories is not guaranteed and push can be denied. This corrects the
      // user path only; plain adb shell/push does not bypass scoped storage.
      return {
        kind: "external",
        absolutePath: `${userId === 0 ? "/sdcard" : `/storage/emulated/${userId}`}/Android/data/${appId}/files/${safePath}`,
      };
    case "library":
      return {
        kind: "unsupported",
        message:
          "library is not available for Android app containers. Use documents, cache, tmp, or externalFiles.",
      };
  }
}

export function iosContainerRelativePath(
  container: AppFileContainer,
  operation: string,
  appId: string,
  platform: Platform,
): string {
  switch (container) {
    case "documents":
      return "Documents";
    case "library":
      return "Library";
    case "cache":
      return join("Library", "Caches");
    case "tmp":
      return "tmp";
    case "externalFiles":
      throw unsupportedAppFileOperation(operation, platform, appId, {
        container,
        reason: "externalFiles is not available for iOS app containers",
      });
  }
}

export type LocalFileListEntry = Omit<AppFileListEntry, "resourceUri">;

export async function listLocalFiles(
  root: string,
  fileSystem: AppFileFileSystem,
): Promise<LocalFileListEntry[]> {
  return listLocalFilesWithPaths(root, fileSystem, hostPath);
}

export async function listLocalFilesWithPaths(
  root: string,
  fileSystem: AppFileFileSystem,
  paths: typeof posix,
): Promise<LocalFileListEntry[]> {
  const entries: LocalFileListEntry[] = [];

  async function visit(dir: string): Promise<void> {
    const children = await fileSystem.readdir(dir);
    for (const child of children) {
      const childPath = paths.join(dir, child.name);
      const stat = await fileSystem.lstat(childPath);
      if (stat.isDirectory()) {
        entries.push(buildLocalListEntry(root, childPath, stat, { isDirectory: true, paths }));
        await visit(childPath);
      } else if (stat.isFile()) {
        entries.push(buildLocalListEntry(root, childPath, stat, { isDirectory: false, paths }));
      }
    }
  }

  try {
    await visit(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return entries;
}

function buildLocalListEntry(
  root: string,
  childPath: string,
  stat: AppFileStats,
  { isDirectory, paths }: { isDirectory: boolean; paths: typeof posix },
): LocalFileListEntry {
  const filePath = paths.relative(root, childPath).replace(/\\/g, "/");
  return {
    path: filePath,
    name: posix.basename(filePath),
    ...(isDirectory ? {} : { byteCount: stat.size }),
    isDirectory,
    lastModified: stat.mtime.toISOString(),
  };
}

interface IosAppContainerCommandContext {
  device: BootedDevice;
  appId: string;
  /** The logical container named in error messages (an app container or an App Group id). */
  container: string;
  operation: string;
}

export async function executeIosAppContainerCommand(
  simctl: Pick<SimCtlClient, "executeCommand">,
  command: string,
  context: IosAppContainerCommandContext,
): Promise<ExecResult> {
  try {
    return await simctl.executeCommand(command);
  } catch (error) {
    throw mapIosAppContainerError(error, context);
  }
}

function mapIosAppContainerError(
  error: unknown,
  context: IosAppContainerCommandContext,
): ActionableError {
  const message = errorMessage(error);
  if (
    /not installed|application.*not.*installed|no such app|bundle.*not found|missing bundle/i.test(
      message,
    )
  ) {
    return new ActionableError(
      `iOS app ${context.appId} is not installed on simulator ${context.device.deviceId}; ` +
        `cannot ${context.operation} ${context.container} app files. Original error: ${message}`,
    );
  }

  if (/no such device|invalid device|unavailable|shutdown|not booted/i.test(message)) {
    return new ActionableError(
      `iOS simulator ${context.device.deviceId} is unavailable or not booted; ` +
        `cannot ${context.operation} ${context.container} app files for ${context.appId}. Original error: ${message}`,
    );
  }

  if (/docker|iOS simulator tooling is only available on macOS/i.test(message)) {
    return new ActionableError(
      `iOS simulator app file ${context.operation} requires local macOS simctl access; ` +
        `Docker-to-host simulator access is unsupported. Original error: ${message}`,
    );
  }

  return new ActionableError(
    `Failed to ${context.operation} iOS simulator ${context.container} app files for ` +
      `${context.appId} on ${context.device.deviceId}: ${message}`,
  );
}

export function parseAndroidStatListing(
  stdout: string,
  root: string,
  device: BootedDevice,
  { appId, container }: { appId: string; container: AppFileContainer },
): AppFileListEntry[] {
  return stdout
    .split(/\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => parseAndroidStatLine(line, root, device, { appId, container }))
    .filter((entry): entry is AppFileListEntry => entry !== null);
}

function parseAndroidStatLine(
  line: string,
  root: string,
  device: BootedDevice,
  { appId, container }: { appId: string; container: AppFileContainer },
): AppFileListEntry | null {
  const parts = line.split("|");
  if (parts.length < 4) {
    return null;
  }

  const [fileType, sizeText, modifiedSecondsText, ...pathParts] = parts;
  const absolutePath = pathParts.join("|");
  if (absolutePath === root) {
    return null;
  }

  const relativePath = absolutePath.startsWith(`${root}/`)
    ? absolutePath.slice(root.length + 1)
    : absolutePath;
  const path = normalizeAppFileRelativePath(relativePath);
  const isDirectory = fileType.toLowerCase().includes("directory");
  const byteCount = Number(sizeText);
  const modifiedSeconds = Number(modifiedSecondsText);

  return {
    path,
    name: posix.basename(path),
    ...(isDirectory || !Number.isFinite(byteCount) ? {} : { byteCount }),
    isDirectory,
    ...(Number.isFinite(modifiedSeconds)
      ? { lastModified: new Date(modifiedSeconds * 1000).toISOString() }
      : {}),
    resourceUri: buildAppFileResourceUri({ deviceId: device.deviceId, appId, container, path }),
  };
}

interface AndroidAppFileCommandContext {
  userId?: number;
  device: BootedDevice;
  appId: string;
  container: AppFileContainer;
  operation: "write" | "list" | "read" | "reset";
  access: "externalFiles" | "run-as";
}

interface AndroidAppFileExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  noRetry?: boolean;
  signal?: AbortSignal;
}

export async function executeAndroidAppFileCommand(
  adb: AdbExecutor,
  command: string,
  context: AndroidAppFileCommandContext,
  options: AndroidAppFileExecOptions = {},
): Promise<ExecResult> {
  try {
    return await adb.executeCommand(command, {
      timeoutMs: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      noRetry: options.noRetry,
      signal: options.signal,
    });
  } catch (error) {
    throw mapAndroidAppFileError(error, context, command);
  }
}

function mapAndroidAppFileError(
  error: unknown,
  context: AndroidAppFileCommandContext,
  command: string,
): ActionableError {
  const message = errorMessage(error);
  const user = context.userId ? ` for user ${context.userId}` : "";
  if (/not debuggable/i.test(message)) {
    return new ActionableError(
      `Android ${context.container} app file ${context.operation} for ${context.appId}${user} on ${context.device.deviceId} ` +
        "requires a debuggable app build because it uses run-as. Install a debuggable build or use externalFiles. " +
        `Original error: ${message}`,
    );
  }

  if (
    /package .* (unknown|not found)|unknown package|not installed|does not exist/i.test(message)
  ) {
    return new ActionableError(
      `Android app ${context.appId} is not installed${user} on ${context.device.deviceId}; ` +
        `cannot ${context.operation} ${context.container} app files. Original error: ${message}`,
    );
  }

  if (/permission denied|operation not permitted/i.test(message)) {
    return new ActionableError(
      `Android ${context.container} app file ${context.operation} for ${context.appId}${user} on ${context.device.deviceId} ` +
        `was denied by the device. ${context.access === "run-as" ? "Use a debuggable build for private storage or choose externalFiles." : "Check app install state and external storage access."} ` +
        `Original error: ${message}`,
    );
  }

  if (
    context.access === "run-as" &&
    command.includes(" --user ") &&
    (/^\s*run-as: (unknown|invalid|unrecognized) option\b/im.test(message) ||
      /^\s*usage: run-as\b/im.test(message))
  ) {
    return new ActionableError(
      `run-as --user appears unsupported on ${context.device.deviceId}'s Android version (unverified which API level)${user}. Omit userId only if the app is installed for the device's primary user, or use a debuggable build via an adb-user-0 session. Original error: ${message}`,
    );
  }

  return new ActionableError(
    `Failed to ${context.operation} Android ${context.container} app files for ${context.appId} on ${context.device.deviceId}: ${message}`,
  );
}

export function decodeUtf8Text(buffer: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    return text.includes("\u0000") ? undefined : text;
  } catch (error) {
    // Strict UTF-8 decoding throws on binary/invalid-encoding data; undefined
    // tells the caller to treat the file as binary instead of as text.
    logger.debug(`src/server/appFileService.ts utf8 decode failed: ${error}`, error);
    return undefined;
  }
}
