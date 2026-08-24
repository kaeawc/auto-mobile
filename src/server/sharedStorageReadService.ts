import { createHash } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice } from "../models";
import { ActionableError } from "../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  AndroidUserTargetResolver,
  type ResolvedUserTarget,
  type UserTargetRequest,
} from "../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { shellQuote } from "../utils/shellQuote";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import {
  buildSharedStorageResourceUri,
  type SharedStorageFileEntry,
  type SharedStorageFileReadResult,
  type SharedStorageNamespaceListing,
} from "./sharedStorageResourceContract";
import {
  normalizeSharedStorageNamespace,
  normalizeSharedStorageRelativePath,
} from "./sharedStorageContract";

const SHARED_STORAGE_MAX_BUFFER = 64 * 1024 * 1024;
const NAMESPACE_MISSING_MARKER = "__AUTOMOBILE_NS_MISSING__";
const FILE_MISSING_MARKER = "__AUTOMOBILE_FILE_MISSING__";

export interface ListSharedStorageRequest {
  deviceId: string;
  namespace: string;
  explicitUserId?: number;
  signal?: AbortSignal;
}

export interface ReadSharedStorageRequest extends ListSharedStorageRequest {
  path: string;
}

export interface SharedStorageReadService {
  list(request: ListSharedStorageRequest): Promise<SharedStorageNamespaceListing>;
  read(request: ReadSharedStorageRequest): Promise<SharedStorageFileReadResult>;
}

/** Narrow seam over {@link AndroidUserTargetResolver} so tests can pin the profile. */
export interface SharedStorageUserResolver {
  resolve(request: UserTargetRequest): Promise<ResolvedUserTarget>;
}

export interface SharedStorageReadServiceDependencies {
  adbFactory?: AdbClientFactory;
  createUserResolver?: (adb: AdbExecutor) => SharedStorageUserResolver;
  deviceResolver?: (deviceId: string) => Promise<BootedDevice | null>;
}

let sharedStorageReadService: SharedStorageReadService | null = null;

export function getSharedStorageReadService(): SharedStorageReadService {
  if (!sharedStorageReadService) {
    sharedStorageReadService = createSharedStorageReadServiceForTesting();
  }
  return sharedStorageReadService;
}

export function createSharedStorageReadServiceForTesting(
  dependencies: SharedStorageReadServiceDependencies = {},
): SharedStorageReadService {
  return new DefaultSharedStorageReadService(
    dependencies.adbFactory ?? defaultAdbClientFactory,
    dependencies.createUserResolver ?? ((adb) => new AndroidUserTargetResolver(adb)),
    dependencies.deviceResolver ?? findBootedDevice,
  );
}

async function findBootedDevice(deviceId: string): Promise<BootedDevice | null> {
  const manager = PlatformDeviceManagerFactory.getInstance();
  const devices = [
    ...(await manager.getBootedDevices("android")),
    ...(await manager.getBootedDevices("ios")),
  ];
  return devices.find((candidate) => candidate.deviceId === deviceId) ?? null;
}

class DefaultSharedStorageReadService implements SharedStorageReadService {
  constructor(
    private readonly adbFactory: AdbClientFactory,
    private readonly createUserResolver: (adb: AdbExecutor) => SharedStorageUserResolver,
    private readonly deviceResolver: (deviceId: string) => Promise<BootedDevice | null>,
  ) {}

  async list(request: ListSharedStorageRequest): Promise<SharedStorageNamespaceListing> {
    const namespace = normalizeSharedStorageNamespace(request.namespace);
    const base: SharedStorageNamespaceListing = {
      deviceId: request.deviceId,
      platform: "android",
      namespace,
      observation: "complete",
      files: [],
    };

    const device = await this.deviceResolver(request.deviceId);
    if (!device) {
      return {
        ...base,
        observation: "unavailable",
        reason: deviceNotBootedReason(request.deviceId),
      };
    }
    base.platform = device.platform;
    if (device.platform !== "android") {
      return { ...base, observation: "unsupported", reason: unsupportedReason(device.platform) };
    }

    const adb = this.adbFactory.create(device);
    let target: ResolvedUserTarget;
    try {
      target = await this.createUserResolver(adb).resolve({
        explicitUserId: request.explicitUserId,
        signal: request.signal,
      });
    } catch (error) {
      logger.warn(
        `[SharedStorageRead] resolve user failed for list: ${errorMessage(error)}`,
        error,
      );
      return { ...base, observation: "unavailable", reason: errorMessage(error) };
    }

    const directory = downloadsDirectory(target.userId, namespace);
    const resolved: SharedStorageNamespaceListing = {
      ...base,
      userId: target.userId,
      userSource: target.source,
      downloadsDirectory: directory,
    };

    try {
      const statOutput = await executeShell(adb, listStatScript(directory), request.signal);
      if (statOutput.trim() === NAMESPACE_MISSING_MARKER) {
        return { ...resolved, observation: "missing", reason: namespaceMissingReason(directory) };
      }
      const shaOutput = await executeShell(adb, listShaScript(directory), request.signal);
      return {
        ...resolved,
        observation: "complete",
        files: parseListing(statOutput, shaOutput, directory, request.deviceId, namespace),
      };
    } catch (error) {
      // A permission-denied read of a non-primary profile's storage also lands
      // here as "unavailable"; note that a missing/inaccessible directory can
      // instead surface as "missing" via the shell existence probe above.
      logger.warn(`[SharedStorageRead] list ${directory} failed: ${errorMessage(error)}`, error);
      return { ...resolved, observation: "unavailable", reason: errorMessage(error) };
    }
  }

  async read(request: ReadSharedStorageRequest): Promise<SharedStorageFileReadResult> {
    const namespace = normalizeSharedStorageNamespace(request.namespace);
    const path = normalizeSharedStorageRelativePath(request.path);
    const base: SharedStorageFileReadResult = {
      deviceId: request.deviceId,
      platform: "android",
      namespace,
      path,
      observation: "complete",
      resourceUri: buildSharedStorageResourceUri({ deviceId: request.deviceId, namespace, path }),
    };

    const device = await this.deviceResolver(request.deviceId);
    if (!device) {
      return {
        ...base,
        observation: "unavailable",
        reason: deviceNotBootedReason(request.deviceId),
      };
    }
    base.platform = device.platform;
    if (device.platform !== "android") {
      return { ...base, observation: "unsupported", reason: unsupportedReason(device.platform) };
    }

    const adb = this.adbFactory.create(device);
    let target: ResolvedUserTarget;
    try {
      target = await this.createUserResolver(adb).resolve({
        explicitUserId: request.explicitUserId,
        signal: request.signal,
      });
    } catch (error) {
      logger.warn(
        `[SharedStorageRead] resolve user failed for read: ${errorMessage(error)}`,
        error,
      );
      return { ...base, observation: "unavailable", reason: errorMessage(error) };
    }
    base.userId = target.userId;

    const directory = downloadsDirectory(target.userId, namespace);
    const file = posix.join(directory, path);
    // Defense in depth: the joined path can never leave the declared namespace.
    if (file !== directory && !file.startsWith(`${directory}/`)) {
      throw new ActionableError(`path escapes shared-storage namespace ${namespace}`);
    }

    try {
      const output = await executeShell(adb, readScript(file), request.signal);
      if (output.trim() === FILE_MISSING_MARKER) {
        return { ...base, observation: "missing", reason: fileMissingReason(file) };
      }
      const buffer = Buffer.from(output.replace(/\s+/g, ""), "base64");
      const text = decodeUtf8Text(buffer);
      return {
        ...base,
        observation: "complete",
        byteCount: buffer.byteLength,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        ...(text === undefined
          ? {
              mimeType: mimeTypeForPath(path) ?? "application/octet-stream",
              blob: buffer.toString("base64"),
            }
          : { mimeType: mimeTypeForPath(path) ?? "text/plain; charset=utf-8", text }),
      };
    } catch (error) {
      logger.warn(`[SharedStorageRead] read ${file} failed: ${errorMessage(error)}`, error);
      return { ...base, observation: "unavailable", reason: errorMessage(error) };
    }
  }
}

function downloadsDirectory(userId: number, namespace: string): string {
  return posix.join(`/storage/emulated/${userId}/Download`, namespace);
}

function listStatScript(directory: string): string {
  return (
    `if [ -d ${shellQuote(directory)} ]; then ` +
    `find ${shellQuote(directory)} -type f -exec stat -c '%s|%Y|%n' {} \\; ; ` +
    `else printf '%s' ${shellQuote(NAMESPACE_MISSING_MARKER)}; fi`
  );
}

function listShaScript(directory: string): string {
  return (
    `if [ -d ${shellQuote(directory)} ]; then ` +
    `find ${shellQuote(directory)} -type f -exec sha256sum {} \\; ; fi`
  );
}

function readScript(file: string): string {
  return (
    `if [ -f ${shellQuote(file)} ]; then base64 ${shellQuote(file)}; ` +
    `else printf '%s' ${shellQuote(FILE_MISSING_MARKER)}; fi`
  );
}

async function executeShell(
  adb: AdbExecutor,
  script: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await adb.executeCommand(
    `shell ${script}`,
    undefined,
    SHARED_STORAGE_MAX_BUFFER,
    true,
    signal,
  );
  return result.stdout;
}

function parseListing(
  statOutput: string,
  shaOutput: string,
  directory: string,
  deviceId: string,
  namespace: string,
): SharedStorageFileEntry[] {
  const hashes = parseShaOutput(shaOutput);
  const prefix = `${directory}/`;
  return statOutput
    .split(/\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)
    .map((line): SharedStorageFileEntry | null => {
      const firstBar = line.indexOf("|");
      const secondBar = line.indexOf("|", firstBar + 1);
      if (firstBar < 0 || secondBar < 0) {
        return null;
      }
      const absolutePath = line.slice(secondBar + 1);
      if (!absolutePath.startsWith(prefix)) {
        return null;
      }
      const relativePath = absolutePath.slice(prefix.length);
      const byteCount = Number(line.slice(0, firstBar));
      const modifiedSeconds = Number(line.slice(firstBar + 1, secondBar));
      const mimeType = mimeTypeForPath(relativePath);
      const sha256 = hashes.get(absolutePath);
      return {
        path: relativePath,
        name: posix.basename(relativePath),
        ...(Number.isFinite(byteCount) ? { byteCount } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(sha256 ? { sha256 } : {}),
        ...(Number.isFinite(modifiedSeconds)
          ? { lastModified: new Date(modifiedSeconds * 1000).toISOString() }
          : {}),
        resourceUri: buildSharedStorageResourceUri({ deviceId, namespace, path: relativePath }),
      };
    })
    .filter((entry): entry is SharedStorageFileEntry => entry !== null);
}

function parseShaOutput(shaOutput: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const rawLine of shaOutput.split(/\n/)) {
    const line = rawLine.replace(/\r$/, "");
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.*)$/);
    if (match) {
      hashes.set(match[2], match[1].toLowerCase());
    }
  }
  return hashes;
}

function decodeUtf8Text(buffer: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    return text.includes("\u0000") ? undefined : text;
  } catch (error) {
    // Strict UTF-8 decoding throws on binary/invalid-encoding data; undefined
    // tells the caller to treat the file as a binary blob instead of text.
    logger.debug(`src/server/sharedStorageReadService.ts utf8 decode failed: ${error}`, error);
    return undefined;
  }
}

// Extension -> MIME for the user-visible file types staged into Downloads. Kept
// deliberately small (no untyped `mime` dependency); unknown extensions fall back
// to the UTF-8/binary split at the call site, so this only adds "when known" types.
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  pdf: "application/pdf",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

function mimeTypeForPath(path: string): string | undefined {
  const base = posix.basename(path);
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0) {
    return undefined;
  }
  return MIME_TYPES_BY_EXTENSION[base.slice(dotIndex + 1).toLowerCase()];
}

function deviceNotBootedReason(deviceId: string): string {
  return `Device not found or not booted: ${deviceId}`;
}

function unsupportedReason(platform: string): string {
  return `User-visible Downloads resources are only supported on Android devices, not ${platform}.`;
}

function namespaceMissingReason(directory: string): string {
  return `Downloads namespace directory does not exist: ${directory}`;
}

function fileMissingReason(file: string): string {
  return `File does not exist in the Downloads namespace: ${file}`;
}
