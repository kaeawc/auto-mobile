import { promises as nodeFs } from "node:fs";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import type { BootedDevice } from "../models";
import { ActionableError } from "../models";
import { defaultAdbClientFactory, type AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { shellQuote } from "../utils/shellQuote";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import { errorMessage } from "../utils/describeUnknownError";
import {
  normalizeSharedStorageNamespace,
  normalizeSharedStorageRelativePath,
  type SharedStorageFileInput,
  type StageSharedStorageArgs,
  type StageSharedStorageResult,
  type StagedSharedStorageFile,
} from "./sharedStorageContract";

const DOWNLOADS_ROOT = "/sdcard/Download";

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
  stat: path => nodeFs.stat(path),
  mkdtemp: prefix => nodeFs.mkdtemp(prefix),
  writeFileBuffer: (path, data) => nodeFs.writeFile(path, data),
  rm: path => nodeFs.rm(path, { recursive: true, force: true }),
};

export interface SharedStorageServiceDependencies {
  adbFactory?: AdbClientFactory;
  fileSystem?: SharedStorageFileSystem;
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
  dependencies: SharedStorageServiceDependencies = {}
): SharedStorageService {
  return new DefaultSharedStorageService(
    dependencies.adbFactory ?? defaultAdbClientFactory,
    dependencies.fileSystem ?? defaultFileSystem,
  );
}

class DefaultSharedStorageService implements SharedStorageService {
  constructor(
    private readonly adbFactory: AdbClientFactory,
    private readonly fileSystem: SharedStorageFileSystem,
  ) {}

  async stage(request: StageSharedStorageRequest): Promise<StageSharedStorageResult> {
    if (request.device.platform !== "android") {
      throw new ActionableError("stageSharedStorage is only supported on Android devices.");
    }
    const namespace = normalizeSharedStorageNamespace(request.namespace);
    const destinationDirectory = posix.join(DOWNLOADS_ROOT, namespace);
    const adb = this.adbFactory.create(request.device);

    if (request.reset) {
      // namespace has exactly one safe segment, so this can only remove Downloads/<namespace>.
      await execute(adb, `shell rm -rf ${shellQuote(destinationDirectory)}`, request.signal);
    }
    await execute(adb, `shell mkdir -p ${shellQuote(destinationDirectory)}`, request.signal);

    const files: StagedSharedStorageFile[] = [];
    for (const file of request.files) {
      files.push(await this.stageFile(adb, request, namespace, destinationDirectory, file));
    }
    return {
      success: true,
      deviceId: request.device.deviceId,
      platform: "android",
      namespace,
      destinationDirectory,
      reset: request.reset ?? false,
      files,
    };
  }

  private async stageFile(
    adb: AdbExecutor,
    request: StageSharedStorageRequest,
    namespace: string,
    destinationDirectory: string,
    file: SharedStorageFileInput,
  ): Promise<StagedSharedStorageFile> {
    const destinationPath = normalizeSharedStorageRelativePath(file.destinationPath);
    const destination = posix.join(destinationDirectory, destinationPath);
    // Re-check the joined result so future path changes cannot widen the reset namespace.
    if (!destination.startsWith(`${destinationDirectory}/`)) {
      throw new ActionableError(`destinationPath escapes shared-storage namespace ${namespace}`);
    }
    const source = await this.prepareSource(file);
    try {
      await execute(adb, `shell mkdir -p ${shellQuote(posix.dirname(destination))}`, request.signal);
      await execute(adb, `push ${shellQuote(source.path)} ${shellQuote(destination)}`, request.signal);
      const mediaIndexing = shouldIndexMedia(destinationPath, request.indexMedia ?? true)
        ? await indexMediaFile(adb, destination, request.signal)
        : { status: "notRequested" as const, reason: indexingNotRequestedReason(destinationPath, request.indexMedia ?? true) };
      return { destinationPath, byteCount: source.byteCount, mediaIndexing };
    } finally {
      await source.cleanup?.();
    }
  }

  private async prepareSource(file: SharedStorageFileInput): Promise<{ path: string; byteCount: number; cleanup?: () => Promise<void> }> {
    if (file.sourcePath !== undefined) {
      const path = resolvePathFromDaemonLaunchWorkingDirectory(file.sourcePath);
      const stat = await this.fileSystem.stat(path);
      if (!stat.isFile()) {
        throw new ActionableError(`sourcePath is not a file: ${path}`);
      }
      return { path, byteCount: stat.size };
    }
    const buffer = file.contentBase64 === undefined
      ? Buffer.from(file.contentText ?? "", "utf8")
      : Buffer.from(file.contentBase64, "base64");
    const directory = await this.fileSystem.mkdtemp(join(tmpdir(), "automobile-shared-storage-"));
    const path = join(directory, "content");
    await this.fileSystem.writeFileBuffer(path, buffer);
    return { path, byteCount: buffer.byteLength, cleanup: () => this.fileSystem.rm(directory) };
  }
}

async function execute(adb: AdbExecutor, command: string, signal?: AbortSignal): Promise<void> {
  try {
    await adb.executeCommand(command, undefined, undefined, true, signal);
  } catch (error) {
    throw new ActionableError(`Android shared-storage operation failed: ${errorMessage(error)}`);
  }
}

async function indexMediaFile(adb: AdbExecutor, destination: string, signal?: AbortSignal): Promise<{ status: "completed" }> {
  await execute(
    adb,
    `shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellQuote(`file://${destination}`)}`,
    signal,
  );
  return { status: "completed" };
}

function shouldIndexMedia(path: string, indexMedia: boolean): boolean {
  return indexMedia && /\.(aac|bmp|flac|gif|heic|jpeg|jpg|m4a|mkv|mov|mp3|mp4|ogg|png|wav|webm|webp)$/i.test(path);
}

function indexingNotRequestedReason(path: string, indexMedia: boolean): string {
  if (!indexMedia) {
    return "media indexing was disabled by indexMedia=false";
  }
  return `media indexing was not requested for ${path}; Android document pickers discover files directly from Downloads`;
}
