import { promises as nodeFs } from "node:fs";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import type { BootedDevice } from "../models";
import { ActionableError } from "../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { shellQuote } from "../utils/shellQuote";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { readAndroidDeviceApiLevel } from "../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import {
  AndroidUserTargetResolver,
  type ResolvedUserTarget,
  type UserTargetRequest,
} from "../utils/android-cmdline-tools/AndroidUserTargetResolver";
import {
  normalizeSharedStorageNamespace,
  normalizeSharedStorageRelativePath,
  type SharedStorageFileInput,
  type StageSharedStorageArgs,
  type StageSharedStorageResult,
  type StagedSharedStorageFile,
} from "./sharedStorageContract";

const DOWNLOADS_DIRECTORY = "Download";

interface SharedStorageStats {
  size: number;
  isFile(): boolean;
}

export interface SharedStorageFileSystem {
  stat(path: string): Promise<SharedStorageStats>;
  mkdtemp(prefix: string): Promise<string>;
  writeFileBuffer(path: string, data: Buffer): Promise<void>;
  rm(path: string): Promise<void>;
}

const defaultFileSystem: SharedStorageFileSystem = {
  stat: (path) => nodeFs.stat(path),
  mkdtemp: (prefix) => nodeFs.mkdtemp(prefix),
  writeFileBuffer: (path, data) => nodeFs.writeFile(path, data),
  rm: (path) => nodeFs.rm(path, { recursive: true, force: true }),
};

export interface SharedStorageServiceDependencies {
  adbFactory?: AdbClientFactory;
  fileSystem?: SharedStorageFileSystem;
  timer?: Timer;
  createUserResolver?: (adb: AdbExecutor) => SharedStorageUserResolver;
}

export interface SharedStorageUserResolver {
  resolve(request?: UserTargetRequest): Promise<ResolvedUserTarget>;
}

export interface StageSharedStorageRequest extends Omit<StageSharedStorageArgs, "device"> {
  device: BootedDevice;
  signal?: AbortSignal;
}

export interface SharedStorageService {
  stage(request: StageSharedStorageRequest): Promise<StageSharedStorageResult>;
}

let sharedStorageService: SharedStorageService | null = null;

export function getSharedStorageService(): SharedStorageService {
  if (!sharedStorageService) {
    sharedStorageService = createSharedStorageServiceForTesting();
  }
  return sharedStorageService;
}

export function setSharedStorageServiceForTesting(service: SharedStorageService): void {
  sharedStorageService = service;
}

export function resetSharedStorageServiceForTesting(): void {
  sharedStorageService = null;
}

export function createSharedStorageServiceForTesting(
  dependencies: SharedStorageServiceDependencies = {},
): SharedStorageService {
  return new DefaultSharedStorageService(
    dependencies.adbFactory ?? defaultAdbClientFactory,
    dependencies.fileSystem ?? defaultFileSystem,
    dependencies.timer ?? defaultTimer,
    dependencies.createUserResolver ?? ((adb) => new AndroidUserTargetResolver(adb)),
  );
}

class DefaultSharedStorageService implements SharedStorageService {
  constructor(
    private readonly adbFactory: AdbClientFactory,
    private readonly fileSystem: SharedStorageFileSystem,
    private readonly timer: Timer,
    private readonly createUserResolver: (adb: AdbExecutor) => SharedStorageUserResolver,
  ) {}

  async stage(request: StageSharedStorageRequest): Promise<StageSharedStorageResult> {
    if (request.device.platform !== "android") {
      throw new ActionableError("stageSharedStorage is only supported on Android devices.");
    }
    const namespace = normalizeSharedStorageNamespace(request.namespace);
    const adb = this.adbFactory.create(request.device);
    let user: ResolvedUserTarget;
    try {
      user = await this.createUserResolver(adb).resolve({ signal: request.signal });
    } catch (error) {
      throw new ActionableError(
        `Android shared-storage could not resolve an active profile for device ${request.device.deviceId} ` +
          `and namespace ${namespace}: ${errorMessage(error)}. ` +
          "Recovery: boot the intended Android profile and retry.",
      );
    }
    const destinationDirectory = downloadsDirectory(user.userId, namespace);
    const preparedFiles = await this.prepareFiles(request.files);
    try {
      if (request.reset) {
        // namespace has exactly one safe segment, so this can only remove Downloads/<namespace>.
        await execute(adb, `shell rm -rf ${shellQuote(destinationDirectory)}`, request.signal);
      }
      await execute(adb, `shell mkdir -p ${shellQuote(destinationDirectory)}`, request.signal);

      const files: StagedSharedStorageFile[] = [];
      for (const file of preparedFiles) {
        files.push(
          await this.stageFile(adb, request, namespace, destinationDirectory, user.userId, file),
        );
      }
      return {
        success: true,
        deviceId: request.device.deviceId,
        platform: "android",
        namespace,
        userId: user.userId,
        userSource: user.source,
        destinationDirectory,
        reset: request.reset ?? false,
        files,
      };
    } finally {
      await Promise.all(preparedFiles.map((file) => file.source.cleanup?.()));
    }
  }

  private async prepareFiles(
    files: SharedStorageFileInput[],
  ): Promise<PreparedSharedStorageFile[]> {
    const prepared: PreparedSharedStorageFile[] = [];
    try {
      for (const file of files) {
        prepared.push({
          destinationPath: normalizeSharedStorageRelativePath(file.destinationPath),
          source: await this.prepareSource(file),
        });
      }
      for (const file of prepared) {
        if (
          prepared.some(
            (other) =>
              other !== file &&
              (other.destinationPath === file.destinationPath ||
                other.destinationPath.startsWith(`${file.destinationPath}/`)),
          )
        ) {
          throw new ActionableError(
            `destinationPath conflicts with a nested fixture: ${file.destinationPath}`,
          );
        }
      }
      return prepared;
    } catch (error) {
      await Promise.all(prepared.map((file) => file.source.cleanup?.()));
      throw error;
    }
  }

  private async stageFile(
    adb: AdbExecutor,
    request: StageSharedStorageRequest,
    namespace: string,
    destinationDirectory: string,
    userId: number,
    file: PreparedSharedStorageFile,
  ): Promise<StagedSharedStorageFile> {
    const destinationPath = file.destinationPath;
    const destination = posix.join(destinationDirectory, destinationPath);
    // Re-check the joined result so future path changes cannot widen the reset namespace.
    if (!destination.startsWith(`${destinationDirectory}/`)) {
      throw new ActionableError(`destinationPath escapes shared-storage namespace ${namespace}`);
    }
    await execute(adb, `shell mkdir -p ${shellQuote(posix.dirname(destination))}`, request.signal);
    await executeArgs(adb, ["push", file.source.path, destination], request.signal);
    const mediaIndexing = shouldIndexMedia(destinationPath, request.indexMedia ?? true)
      ? await indexMediaFile(adb, destination, destinationPath, userId, this.timer, request.signal)
      : {
          status: "notRequested" as const,
          reason: indexingNotRequestedReason(destinationPath, request.indexMedia ?? true),
        };
    return { destinationPath, byteCount: file.source.byteCount, mediaIndexing };
  }

  private async prepareSource(
    file: SharedStorageFileInput,
  ): Promise<{ path: string; byteCount: number; cleanup?: () => Promise<void> }> {
    if (file.sourcePath !== undefined) {
      const path = resolvePathFromDaemonLaunchWorkingDirectory(file.sourcePath);
      const stat = await this.fileSystem.stat(path);
      if (!stat.isFile()) {
        throw new ActionableError(`sourcePath is not a file: ${path}`);
      }
      return { path, byteCount: stat.size };
    }
    const buffer =
      file.contentBase64 === undefined
        ? Buffer.from(file.contentText ?? "", "utf8")
        : Buffer.from(file.contentBase64, "base64");
    const directory = await this.fileSystem.mkdtemp(join(tmpdir(), "automobile-shared-storage-"));
    const path = join(directory, "content");
    await this.fileSystem.writeFileBuffer(path, buffer);
    return { path, byteCount: buffer.byteLength, cleanup: () => this.fileSystem.rm(directory) };
  }
}

interface PreparedSharedStorageFile {
  destinationPath: string;
  source: { path: string; byteCount: number; cleanup?: () => Promise<void> };
}

async function execute(adb: AdbExecutor, command: string, signal?: AbortSignal): Promise<void> {
  try {
    await adb.executeCommand(command, undefined, undefined, true, signal);
  } catch (error) {
    throw new ActionableError(`Android shared-storage operation failed: ${errorMessage(error)}`);
  }
}

async function executeArgs(adb: AdbExecutor, args: string[], signal?: AbortSignal): Promise<void> {
  try {
    await adb.execute(args, { noRetry: true, signal });
  } catch (error) {
    throw new ActionableError(`Android shared-storage operation failed: ${errorMessage(error)}`);
  }
}

async function indexMediaFile(
  adb: AdbExecutor,
  destination: string,
  destinationPath: string,
  userId: number,
  timer: Timer,
  signal?: AbortSignal,
): Promise<{ status: "completed" }> {
  await execute(
    adb,
    `shell am broadcast --user ${userId} -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellQuote(`file://${destination}`)}`,
    signal,
  );
  const collection = mediaCollectionFor(destinationPath);
  const apiLevel = await readAndroidDeviceApiLevel(adb);
  const modernQuery = apiLevel === null || apiLevel >= 29;
  const downloadsPrefix = `/${DOWNLOADS_DIRECTORY}/`;
  const downloadsIndex = destination.indexOf(downloadsPrefix);
  if (downloadsIndex < 0) {
    throw new ActionableError(`Android media fixture is outside Downloads: ${destination}`);
  }
  const deviceRelativePath = destination.slice(downloadsIndex + downloadsPrefix.length);
  const deviceRelativeDirectory = posix.dirname(deviceRelativePath);
  const relativePath =
    deviceRelativeDirectory === "." ? "Download/" : `Download/${deviceRelativeDirectory}/`;
  const selection = modernQuery
    ? `relative_path=${sqlString(relativePath)} AND _display_name=${sqlString(posix.basename(destination))}`
    : `_data=${sqlString(destination.replace("/sdcard/", "/storage/emulated/0/"))}`;
  const volume = modernQuery ? "external_primary" : "external";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await executeResult(
      adb,
      `shell content query --user ${userId} --uri content://media/${volume}/${collection}/media --projection _id --where ${shellQuote(selection)}`,
      signal,
    );
    if (/^Row:/m.test(result.stdout)) {
      return { status: "completed" };
    }
    await timer.sleep(250);
  }
  throw new ActionableError(
    `Android media indexing did not complete for ${destination} within 5 seconds.`,
  );
}

async function executeResult(adb: AdbExecutor, command: string, signal?: AbortSignal) {
  try {
    return await adb.executeCommand(command, undefined, undefined, true, signal);
  } catch (error) {
    throw new ActionableError(`Android shared-storage operation failed: ${errorMessage(error)}`);
  }
}

function mediaCollectionFor(path: string): "images" | "video" | "audio" {
  if (/\.(bmp|gif|heic|jpeg|jpg|png|webp)$/i.test(path)) {
    return "images";
  }
  if (/\.(mkv|mov|mp4|webm)$/i.test(path)) {
    return "video";
  }
  return "audio";
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shouldIndexMedia(path: string, indexMedia: boolean): boolean {
  return (
    indexMedia &&
    /\.(aac|bmp|flac|gif|heic|jpeg|jpg|m4a|mkv|mov|mp3|mp4|ogg|png|wav|webm|webp)$/i.test(path)
  );
}

function indexingNotRequestedReason(path: string, indexMedia: boolean): string {
  if (!indexMedia) {
    return "media indexing was disabled by indexMedia=false";
  }
  return `media indexing was not requested for ${path}; Android document pickers discover files directly from Downloads`;
}

function downloadsDirectory(userId: number, namespace: string): string {
  return posix.join(`/storage/emulated/${userId}`, DOWNLOADS_DIRECTORY, namespace);
}
