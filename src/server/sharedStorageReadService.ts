import { SimctlIosFilesFixtureContainer, nodeAppFileFileSystem } from "./appFileService";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice, Platform } from "../models";
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
import {
  buildSharedStorageResourceUri,
  buildCanonicalUserFilesResourceUri,
  buildCanonicalMediaLibraryResourceUri,
  type SharedStorageFileEntry,
  type SharedStorageFileReadResult,
  type SharedStorageNamespaceListing,
} from "./sharedStorageResourceContract";
import {
  normalizeSharedStorageNamespace,
  normalizeSharedStorageRelativePath,
} from "./sharedStorageContract";
import { findBootedDeviceForResource } from "./resourceDeviceResolver";

const SHARED_STORAGE_MAX_BUFFER = 64 * 1024 * 1024;
const SHARED_STORAGE_BULK_TIMEOUT_MS = 120_000;
const NAMESPACE_MISSING_MARKER = "__AUTOMOBILE_NS_MISSING__";
const FILE_MISSING_MARKER = "__AUTOMOBILE_FILE_MISSING__";

export interface ListSharedStorageRequest {
  deviceId: string;
  namespace: string;
  domain?: "user_files" | "media_library";
  explicitUserId?: number;
  signal?: AbortSignal;
}

export interface ReadSharedStorageRequest extends ListSharedStorageRequest {
  path: string;
}

export interface SharedStorageReadCoverage {
  readonly list: boolean;
  readonly read: boolean;
}

export const IOS_MEDIA_READ_UNSUPPORTED_REASON =
  "simctl addmedia imports fixtures but exposes no supported bounded enumeration or read API for imported media.";

/** Coverage of registered bounded namespace readers. */
export function describeDefaultSharedStorageReadCoverage(
  platform: Platform,
  domain: "user_files" | "media_library" = "user_files",
): SharedStorageReadCoverage {
  const available = domain === "user_files" || platform === "android";
  return { list: available, read: available };
}

export interface SharedStorageReadService {
  describeReadCoverage?(
    platform: Platform,
    domain?: "user_files" | "media_library",
  ): SharedStorageReadCoverage;
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
  hashCache?: SharedStorageHashCache;
  iosFixtureReader?: Pick<SimctlIosFilesFixtureContainer, "listNamespace" | "readNamespaceFile">;
}

export interface SharedStorageHashCache {
  get(
    deviceId: string,
    namespace: string,
    path: string,
    byteCount: number,
    modifiedSeconds: number,
  ): string | undefined;
  set(
    deviceId: string,
    namespace: string,
    path: string,
    byteCount: number,
    modifiedSeconds: number,
    sha256: string,
  ): void;
  retainNamespacePaths(deviceId: string, namespace: string, paths: ReadonlySet<string>): void;
}

const SHARED_STORAGE_HASH_CACHE_MAX_ENTRIES = 2_048;
const SHARED_STORAGE_HASH_COMMAND_MAX_LENGTH = 24 * 1024;
const SHA256_UNAVAILABLE_REASON = "Hash unavailable: file changed or disappeared during listing";

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
    dependencies.hashCache ?? new BoundedSharedStorageHashCache(),
    dependencies.iosFixtureReader ??
      new SimctlIosFilesFixtureContainer(
        (device) => new SimCtlClient(device),
        nodeAppFileFileSystem,
      ),
  );
}

async function findBootedDevice(deviceId: string): Promise<BootedDevice | null> {
  return findBootedDeviceForResource(deviceId, "SharedStorageReadService");
}

class DefaultSharedStorageReadService implements SharedStorageReadService {
  describeReadCoverage(
    platform: Platform,
    domain: "user_files" | "media_library" = "user_files",
  ): SharedStorageReadCoverage {
    return describeDefaultSharedStorageReadCoverage(platform, domain);
  }

  constructor(
    private readonly adbFactory: AdbClientFactory,
    private readonly createUserResolver: (adb: AdbExecutor) => SharedStorageUserResolver,
    private readonly deviceResolver: (deviceId: string) => Promise<BootedDevice | null>,
    private readonly hashCache: SharedStorageHashCache,
    private readonly iosFixtureReader: Pick<
      SimctlIosFilesFixtureContainer,
      "listNamespace" | "readNamespaceFile"
    >,
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
    const restriction = readRestriction(device, request);
    if (restriction) {
      return { ...base, observation: "unsupported", reason: restriction };
    }
    if (device.platform === "ios") {
      return this.listIos(device, request, base);
    }

    const adb = this.adbFactory.create(device);
    let target: ResolvedUserTarget;
    try {
      target = await this.createUserResolver(adb).resolve({
        explicitUserId: request.explicitUserId,
        currentUser: true,
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
        this.hashCache.retainNamespacePaths(request.deviceId, namespace, new Set());
        return { ...resolved, observation: "missing", reason: namespaceMissingReason(directory) };
      }
      const statEntries = parseStatOutput(statOutput, directory);
      this.hashCache.retainNamespacePaths(
        request.deviceId,
        namespace,
        new Set(statEntries.map((entry) => entry.absolutePath)),
      );
      const hashes = await listHashes(
        adb,
        statEntries,
        request,
        namespace,
        directory,
        this.hashCache,
      );
      return {
        ...resolved,
        observation: "complete",
        files: parseListing(statEntries, hashes, request.deviceId, namespace).map((entry) => ({
          ...entry,
          resourceUri: resourceUriFor(request)({
            deviceId: request.deviceId,
            namespace,
            path: entry.path,
          }),
        })),
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
      resourceUri: resourceUriFor(request)({ deviceId: request.deviceId, namespace, path }),
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
    if (device.platform === "ios" && request.domain !== "media_library") {
      base.resourceUri = buildCanonicalUserFilesResourceUri({
        deviceId: request.deviceId,
        namespace,
        path,
      });
    }
    const restriction = readRestriction(device, request);
    if (restriction) {
      return { ...base, observation: "unsupported", reason: restriction };
    }
    if (device.platform === "ios") {
      return this.readIos(device, request, base);
    }

    const adb = this.adbFactory.create(device);
    let target: ResolvedUserTarget;
    try {
      target = await this.createUserResolver(adb).resolve({
        explicitUserId: request.explicitUserId,
        currentUser: true,
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
      return { ...base, ...readContent(buffer, path) };
    } catch (error) {
      logger.warn(`[SharedStorageRead] read ${file} failed: ${errorMessage(error)}`, error);
      return { ...base, observation: "unavailable", reason: errorMessage(error) };
    }
  }
  private async listIos(
    device: BootedDevice,
    request: ListSharedStorageRequest,
    base: SharedStorageNamespaceListing,
  ): Promise<SharedStorageNamespaceListing> {
    try {
      const entries = await this.iosFixtureReader.listNamespace(
        device,
        base.namespace,
        request.signal,
      );
      return {
        ...base,
        files: entries.map((entry) => ({
          path: entry.path,
          name: entry.name ?? posix.basename(entry.path),
          byteCount: entry.byteCount,
          lastModified: entry.lastModified,
          mimeType: mimeTypeForPath(entry.path),
          resourceUri: buildCanonicalUserFilesResourceUri({
            deviceId: device.deviceId,
            namespace: base.namespace,
            path: entry.path,
          }),
        })),
      };
    } catch (error) {
      logger.warn("[SharedStorageRead] iOS namespace list failed", error);
      return {
        ...base,
        observation: isMissing(error) ? "missing" : "unavailable",
        reason: errorMessage(error),
      };
    }
  }

  private async readIos(
    device: BootedDevice,
    request: ReadSharedStorageRequest,
    base: SharedStorageFileReadResult,
  ): Promise<SharedStorageFileReadResult> {
    try {
      const buffer = await this.iosFixtureReader.readNamespaceFile(
        device,
        base.namespace,
        base.path,
        request.signal,
      );
      return { ...base, ...readContent(buffer, base.path) };
    } catch (error) {
      logger.warn("[SharedStorageRead] iOS namespace read failed", error);
      return {
        ...base,
        observation: isMissing(error) ? "missing" : "unavailable",
        reason: errorMessage(error),
      };
    }
  }
}

/** Shared byte encoding and metadata for both bounded platform readers. */
function readContent(
  buffer: Buffer,
  path: string,
): Pick<SharedStorageFileReadResult, "byteCount" | "sha256" | "mimeType" | "text" | "blob"> {
  const text = decodeUtf8Text(buffer);
  return {
    byteCount: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    mimeType:
      mimeTypeForPath(path) ??
      (text === undefined ? "application/octet-stream" : "text/plain; charset=utf-8"),
    ...(text === undefined ? { blob: buffer.toString("base64") } : { text }),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function resourceUriFor(request: ListSharedStorageRequest) {
  return request.domain === "media_library"
    ? buildCanonicalMediaLibraryResourceUri
    : buildSharedStorageResourceUri;
}

function readRestriction(
  device: BootedDevice,
  request: ListSharedStorageRequest,
): string | undefined {
  if (request.domain === "media_library") {
    if (device.platform === "ios") {
      return IOS_MEDIA_READ_UNSUPPORTED_REASON;
    }
    if (normalizeSharedStorageNamespace(request.namespace) !== "automobile-media") {
      return "Only the putAppFile automobile-media namespace supports media_library list/read.";
    }
  }
  if (device.platform === "ios" && resolveIosDeviceKind(device) !== "simulator") {
    return unsupportedReason(device.platform);
  }
  return undefined;
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

function listShaScript(paths: readonly string[]): string {
  return `sha256sum ${paths.map((path) => shellQuote(path)).join(" ")}`;
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
    SHARED_STORAGE_BULK_TIMEOUT_MS,
    SHARED_STORAGE_MAX_BUFFER,
    true,
    signal,
  );
  return result.stdout;
}

interface ParsedStatEntry {
  path: string;
  absolutePath: string;
  byteCount: number;
  modifiedSeconds: number;
}

function parseStatOutput(statOutput: string, directory: string): ParsedStatEntry[] {
  const prefix = `${directory}/`;
  return statOutput
    .split(/\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)
    .map((line): ParsedStatEntry | null => {
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
      if (!Number.isFinite(byteCount) || !Number.isFinite(modifiedSeconds)) {
        return null;
      }
      return { path: relativePath, absolutePath, byteCount, modifiedSeconds };
    })
    .filter((entry): entry is ParsedStatEntry => entry !== null);
}

function parseListing(
  statEntries: ParsedStatEntry[],
  hashes: ReadonlyMap<string, string>,
  deviceId: string,
  namespace: string,
): SharedStorageFileEntry[] {
  return statEntries.map((entry) => {
    const mimeType = mimeTypeForPath(entry.path);
    const sha256 = hashes.get(entry.absolutePath);
    return {
      path: entry.path,
      name: posix.basename(entry.path),
      byteCount: entry.byteCount,
      ...(mimeType ? { mimeType } : {}),
      ...(sha256 ? { sha256 } : { sha256Unavailable: SHA256_UNAVAILABLE_REASON }),
      lastModified: new Date(entry.modifiedSeconds * 1000).toISOString(),
      resourceUri: buildSharedStorageResourceUri({ deviceId, namespace, path: entry.path }),
    };
  });
}

function parseShaOutput(shaOutput: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const rawLine of shaOutput.split(/\n/)) {
    const line = rawLine.replace(/\r$/, "");
    const match = line.match(/^([0-9a-f]{64})  (.*)$/);
    if (match) {
      hashes.set(match[2], match[1].toLowerCase());
    }
  }
  return hashes;
}

async function listHashes(
  adb: AdbExecutor,
  entries: readonly ParsedStatEntry[],
  request: ListSharedStorageRequest,
  namespace: string,
  directory: string,
  cache: SharedStorageHashCache,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const pending = entries.filter((entry) => {
    const cached = cache.get(
      request.deviceId,
      namespace,
      entry.absolutePath,
      entry.byteCount,
      entry.modifiedSeconds,
    );
    if (cached) {
      hashes.set(entry.absolutePath, cached);
    }
    return !cached;
  });
  for (const batch of chunkHashPaths(pending)) {
    let shaOutput: string;
    try {
      shaOutput = await executeShell(
        adb,
        listShaScript(batch.map((entry) => entry.absolutePath)),
        request.signal,
      );
    } catch (error) {
      logger.warn(
        `[SharedStorageRead] hash files in ${directory} failed: ${errorMessage(error)}`,
        error,
      );
      continue;
    }
    const batchHashes = parseShaOutput(shaOutput);
    for (const entry of batch) {
      const sha256 = batchHashes.get(entry.absolutePath);
      if (!sha256) {
        continue;
      }
      hashes.set(entry.absolutePath, sha256);
      cache.set(
        request.deviceId,
        namespace,
        entry.absolutePath,
        entry.byteCount,
        entry.modifiedSeconds,
        sha256,
      );
    }
    // Hash lines for paths absent from stat output are ignored because only requested paths are read.
  }
  return hashes;
}

class BoundedSharedStorageHashCache implements SharedStorageHashCache {
  private readonly entries = new Map<
    string,
    {
      deviceId: string;
      namespace: string;
      path: string;
      sha256: string;
      lastUsed: number;
    }
  >();
  private accessCounter = 0;

  get(
    deviceId: string,
    namespace: string,
    path: string,
    byteCount: number,
    modifiedSeconds: number,
  ): string | undefined {
    const entry = this.entries.get(
      hashCacheKey(deviceId, namespace, path, byteCount, modifiedSeconds),
    );
    if (!entry) {
      return undefined;
    }
    entry.lastUsed = ++this.accessCounter;
    return entry.sha256;
  }

  set(
    deviceId: string,
    namespace: string,
    path: string,
    byteCount: number,
    modifiedSeconds: number,
    sha256: string,
  ): void {
    for (const [key, entry] of this.entries) {
      if (entry.deviceId === deviceId && entry.namespace === namespace && entry.path === path) {
        this.entries.delete(key);
      }
    }
    this.entries.set(hashCacheKey(deviceId, namespace, path, byteCount, modifiedSeconds), {
      deviceId,
      namespace,
      path,
      sha256,
      lastUsed: ++this.accessCounter,
    });
    while (this.entries.size > SHARED_STORAGE_HASH_CACHE_MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestUsed = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastUsed < oldestUsed) {
          oldestKey = key;
          oldestUsed = entry.lastUsed;
        }
      }
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  retainNamespacePaths(deviceId: string, namespace: string, paths: ReadonlySet<string>): void {
    for (const [key, entry] of this.entries) {
      if (entry.deviceId === deviceId && entry.namespace === namespace && !paths.has(entry.path)) {
        this.entries.delete(key);
      }
    }
  }
}

function hashCacheKey(
  deviceId: string,
  namespace: string,
  path: string,
  byteCount: number,
  modifiedSeconds: number,
): string {
  return JSON.stringify([deviceId, namespace, path, byteCount, modifiedSeconds]);
}

function chunkHashPaths(entries: readonly ParsedStatEntry[]): ParsedStatEntry[][] {
  const batches: ParsedStatEntry[][] = [];
  let batch: ParsedStatEntry[] = [];
  let length = "sha256sum ".length;
  for (const entry of entries) {
    const quotedLength = shellQuote(entry.absolutePath).length + (batch.length > 0 ? 1 : 0);
    if (batch.length > 0 && length + quotedLength > SHARED_STORAGE_HASH_COMMAND_MAX_LENGTH) {
      batches.push(batch);
      batch = [];
      length = "sha256sum ".length;
    }
    batch.push(entry);
    length += quotedLength;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
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
  return `Bounded user_files reads require Android or an iOS Simulator; physical ${platform} devices are unsupported.`;
}

function namespaceMissingReason(directory: string): string {
  return `Downloads namespace directory does not exist: ${directory}`;
}

function fileMissingReason(file: string): string {
  return `File does not exist in the Downloads namespace: ${file}`;
}
