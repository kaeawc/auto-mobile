import { posix } from "node:path";
import { ActionableError, type BootedDevice, type ExecResult } from "../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { shellQuote } from "../utils/shellQuote";
import { normalizeAppFileRelativePath } from "./appFileContract";
import {
  normalizeSharedStorageNamespace,
  type StageSharedStorageArgs,
  type StageSharedStorageResult,
  type StagedSharedStorageFile,
} from "./sharedStorageContract";
import { prepareFileSource, type FileSourceFileSystem } from "./fileSourcePreparation";

const SHARED_STORAGE_ROOT = "/storage/emulated/0/Download/AutoMobile";
const MEDIA_EXTENSIONS =
  /\.(3gp|aac|avi|flac|gif|heic|jpeg|jpg|m4a|m4v|mkv|mp3|mp4|ogg|png|webm|webp|wav)$/i;

export type StageSharedStorageRequest = Omit<StageSharedStorageArgs, "device"> & {
  device: BootedDevice;
  signal?: AbortSignal;
};

export interface SharedStorageServiceDependencies {
  adbFactory?: AdbClientFactory;
  fileSystem?: FileSourceFileSystem;
}

export interface SharedStorageService {
  stage(request: StageSharedStorageRequest): Promise<StageSharedStorageResult>;
}

export function createSharedStorageServiceForTesting(
  deps: SharedStorageServiceDependencies = {},
): SharedStorageService {
  return new DefaultSharedStorageService(
    deps.adbFactory ?? defaultAdbClientFactory,
    deps.fileSystem,
  );
}

let sharedStorageService: SharedStorageService | null = null;

export function getSharedStorageService(): SharedStorageService {
  sharedStorageService ??= createSharedStorageServiceForTesting();
  return sharedStorageService;
}

export function resetSharedStorageServiceForTesting(): void {
  sharedStorageService = null;
}

class DefaultSharedStorageService implements SharedStorageService {
  constructor(
    private readonly adbFactory: AdbClientFactory,
    private readonly fileSystem?: FileSourceFileSystem,
  ) {}

  async stage(request: StageSharedStorageRequest): Promise<StageSharedStorageResult> {
    if (request.device.platform !== "android") {
      throw new ActionableError("Shared storage fixtures are supported only on Android.");
    }

    const namespace = normalizeSharedStorageNamespace(request.namespace);
    const root = posix.join(SHARED_STORAGE_ROOT, namespace);
    const prepared = await this.prepareSources(request.files);
    const adb = this.adbFactory.create(request.device);

    try {
      this.validateDestinations(prepared);
      if (request.reset) {
        await this.execute(adb, `shell rm -rf -- ${shellQuote(root)}`, request, "reset");
      }
      await this.execute(
        adb,
        `shell mkdir -p -- ${shellQuote(root)}`,
        request,
        "create shared storage namespace",
      );

      const files: StagedSharedStorageFile[] = [];
      for (const entry of prepared) {
        files.push(await this.stageFile(adb, root, entry, request));
      }

      return {
        success: true,
        deviceId: request.device.deviceId,
        platform: "android",
        namespace,
        root,
        reset: request.reset ?? false,
        files,
      };
    } finally {
      await Promise.all(prepared.map((entry) => entry.source.cleanup?.() ?? Promise.resolve()));
    }
  }

  private async prepareSources(files: StageSharedStorageArgs["files"]): Promise<
    Array<{
      file: StageSharedStorageArgs["files"][number];
      destinationPath: string;
      source: Awaited<ReturnType<typeof prepareFileSource>>;
    }>
  > {
    const prepared: Array<{
      file: StageSharedStorageArgs["files"][number];
      destinationPath: string;
      source: Awaited<ReturnType<typeof prepareFileSource>>;
    }> = [];
    try {
      for (const file of files) {
        prepared.push({
          file,
          destinationPath: normalizeAppFileRelativePath(file.destinationPath),
          source: await prepareFileSource(file, this.fileSystem),
        });
      }
      return prepared;
    } catch (error) {
      await Promise.all(prepared.map((entry) => entry.source.cleanup?.() ?? Promise.resolve()));
      throw new ActionableError(`Failed to prepare shared storage sources: ${errorMessage(error)}`);
    }
  }

  private validateDestinations(entries: Array<{ destinationPath: string }>): void {
    const destinations = new Set<string>();
    for (const entry of entries) {
      if (destinations.has(entry.destinationPath)) {
        throw new ActionableError(`Duplicate destinationPath: ${entry.destinationPath}`);
      }
      destinations.add(entry.destinationPath);
    }
  }

  private async stageFile(
    adb: AdbExecutor,
    root: string,
    entry: {
      file: StageSharedStorageArgs["files"][number];
      destinationPath: string;
      source: Awaited<ReturnType<typeof prepareFileSource>>;
    },
    request: StageSharedStorageRequest,
  ): Promise<StagedSharedStorageFile> {
    const devicePath = posix.join(root, entry.destinationPath);
    await this.execute(
      adb,
      `shell mkdir -p -- ${shellQuote(posix.dirname(devicePath))}`,
      request,
      "create shared storage directory",
    );
    await this.execute(
      adb,
      `push ${shellQuote(entry.source.path)} ${shellQuote(devicePath)}`,
      request,
      "write shared storage fixture",
    );
    const shouldIndex =
      entry.file.mimeType !== undefined || MEDIA_EXTENSIONS.test(entry.destinationPath);
    if (shouldIndex) {
      await this.execute(
        adb,
        `shell am broadcast --receiver-include-background -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellQuote(`file://${devicePath}`)}`,
        request,
        "request media indexing",
      );
    }
    return {
      destinationPath: entry.destinationPath,
      devicePath,
      byteCount: entry.source.byteCount,
      indexing: shouldIndex ? "dispatched" : "notRequested",
      ...(shouldIndex
        ? {}
        : {
            indexingReason:
              "File is not a recognized media type and was written for document-picker use.",
          }),
    };
  }

  private async execute(
    adb: AdbExecutor,
    command: string,
    request: StageSharedStorageRequest,
    operation: string,
  ): Promise<ExecResult> {
    try {
      return await adb.executeCommand(command, undefined, undefined, true, request.signal);
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(
        `Failed to ${operation} on Android device ${request.device.deviceId}: ${message}`,
        error,
      );
      throw new ActionableError(
        `Failed to ${operation} on Android device ${request.device.deviceId}. ` +
          `Verify the device is booted and shared storage is writable. Original error: ${message}`,
      );
    }
  }
}
