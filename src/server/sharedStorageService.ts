import { SHARED_STORAGE_PUSH_TIMEOUT_MS } from "../features/storage/fileTransferTimeout";
import { runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
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
import { truncateBodyText } from "../utils/truncateBodyText";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import { readAndroidDeviceApiLevel } from "../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import {
  AndroidUserTargetResolver,
  type ResolvedUserTarget,
  type UserTargetRequest,
} from "../utils/android-cmdline-tools/AndroidUserTargetResolver";
import {
  androidRollbackScript,
  androidSaveBackupScript,
  androidStepsScript,
} from "./androidFileBackup";
import {
  normalizeSharedStorageNamespace,
  normalizeSharedStorageRelativePath,
  type SharedStorageFileInput,
  type StageSharedStorageArgs,
  type StageSharedStorageResult,
  type StagedSharedStorageFile,
} from "./sharedStorageContract";

const DOWNLOADS_DIRECTORY = "Download";
export { SHARED_STORAGE_PUSH_TIMEOUT_MS } from "../features/storage/fileTransferTimeout";
const SHARED_STORAGE_ROLLBACK_COMMAND_TIMEOUT_MS = 5000;
const SHARED_STORAGE_ROLLBACK_TOTAL_TIMEOUT_MS = 15000;
const SHARED_STORAGE_ROLLBACK_MAX_PATHS_PER_COMMAND = 64;
/** Printed by the backup script only when it saved the previous content of an existing file. */
const SHARED_STORAGE_BACKUP_MARKER = "AUTOMOBILE_SHARED_STORAGE_BACKUP";

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
  idGenerator?: IdGenerator;
  createUserResolver?: (adb: AdbExecutor) => SharedStorageUserResolver;
}

export interface SharedStorageUserResolver {
  resolve(request?: UserTargetRequest): Promise<ResolvedUserTarget>;
}

export interface StageSharedStorageRequest extends Omit<StageSharedStorageArgs, "device"> {
  device: BootedDevice;
  explicitUserId?: number;
  signal?: AbortSignal;
  /** Roll back files written by this call if any write or media index fails. */
  rollbackOnFailure?: boolean;
  /** Treat a file that was not indexed as a batch failure. */
  requireMediaIndexing?: boolean;
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

export function createSharedStorageServiceForTesting(
  dependencies: SharedStorageServiceDependencies = {},
): SharedStorageService {
  return new DefaultSharedStorageService(
    dependencies.adbFactory ?? defaultAdbClientFactory,
    dependencies.fileSystem ?? defaultFileSystem,
    dependencies.timer ?? defaultTimer,
    dependencies.createUserResolver ?? ((adb) => new AndroidUserTargetResolver(adb)),
    dependencies.idGenerator ?? defaultIdGenerator,
  );
}

class DefaultSharedStorageService implements SharedStorageService {
  constructor(
    private readonly adbFactory: AdbClientFactory,
    private readonly fileSystem: SharedStorageFileSystem,
    private readonly timer: Timer,
    private readonly createUserResolver: (adb: AdbExecutor) => SharedStorageUserResolver,
    private readonly idGenerator: IdGenerator,
  ) {}

  async stage(request: StageSharedStorageRequest): Promise<StageSharedStorageResult> {
    if (request.device.platform !== "android") {
      throw new ActionableError("stageSharedStorage is only supported on Android devices.");
    }
    const namespace = normalizeSharedStorageNamespace(request.namespace);
    const preparedFiles = await this.prepareFiles(request.files);
    const adb = this.adbFactory.create(request.device);
    try {
      let user: ResolvedUserTarget;
      try {
        user = await this.createUserResolver(adb).resolve({
          explicitUserId: request.explicitUserId,
          currentUser: true,
          signal: request.signal,
        });
      } catch (error) {
        throw new ActionableError(
          `Android shared-storage could not resolve an active profile for device ${request.device.deviceId} ` +
            `and namespace ${namespace}: ${errorMessage(error)}. ` +
            "Recovery: boot the intended Android profile and retry.",
        );
      }
      const destinationDirectory = downloadsDirectory(user.userId, namespace);
      if (request.reset) {
        // namespace has exactly one safe segment, so this can only remove Downloads/<namespace>.
        await execute(
          adb,
          `shell rm -rf ${shellQuote(destinationDirectory)}`,
          request.signal,
          SHARED_STORAGE_PUSH_TIMEOUT_MS,
        );
      }
      await execute(adb, `shell mkdir -p ${shellQuote(destinationDirectory)}`, request.signal);

      const files = await this.stagePreparedFiles({
        adb,
        request,
        namespace,
        destinationDirectory,
        userId: user.userId,
        files: preparedFiles,
      });
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

  private async stageFile(context: {
    adb: AdbExecutor;
    request: StageSharedStorageRequest;
    namespace: string;
    destinationDirectory: string;
    userId: number;
    file: PreparedSharedStorageFile;
    /** Runs immediately before the staged copy is renamed over the destination. */
    onBeforeCommit?: () => void;
    /** Runs once the destination holds the complete new content. */
    onPushed?: () => void;
  }): Promise<StagedSharedStorageFile> {
    const { adb, request, namespace, destinationDirectory, userId, file } = context;
    const { onBeforeCommit, onPushed } = context;
    const destinationPath = file.destinationPath;
    const destination = posix.join(destinationDirectory, destinationPath);
    // Re-check the joined result so future path changes cannot widen the reset namespace.
    if (!destination.startsWith(`${destinationDirectory}/`)) {
      throw new ActionableError(`destinationPath escapes shared-storage namespace ${namespace}`);
    }
    await execute(adb, `shell mkdir -p ${shellQuote(posix.dirname(destination))}`, request.signal);
    await this.pushThroughTemp({
      adb,
      request,
      source: file.source.path,
      destination,
      onBeforeCommit,
    });
    onPushed?.();
    const mediaIndexing = shouldIndexMedia(destinationPath, request.indexMedia ?? true)
      ? await indexMediaFile(adb, destination, destinationPath, userId, this.timer, request.signal)
      : {
          status: "notRequested" as const,
          reason: indexingNotRequestedReason(destinationPath, request.indexMedia ?? true),
        };
    return { destinationPath, byteCount: file.source.byteCount, mediaIndexing };
  }

  /**
   * Pushes to a hidden name beside the destination, then renames it into place, so the destination
   * is either its old content or the complete new content. A push cut off mid-transfer (timeout,
   * cancellation, dropped connection) only ever leaves the temp file, which is removed here.
   */
  private async pushThroughTemp(context: {
    adb: AdbExecutor;
    request: StageSharedStorageRequest;
    source: string;
    destination: string;
    onBeforeCommit?: () => void;
  }): Promise<void> {
    const { adb, request, source, destination, onBeforeCommit } = context;
    // Dot-prefixed with a non-media extension so MediaStore never lists the in-flight copy.
    const temp = posix.join(
      posix.dirname(destination),
      `.automobile-${this.idGenerator.next()}.part`,
    );
    try {
      await executeArgs(
        adb,
        ["push", source, temp],
        request.signal,
        SHARED_STORAGE_PUSH_TIMEOUT_MS,
      );
      onBeforeCommit?.();
      await execute(
        adb,
        `shell mv -f ${shellQuote(temp)} ${shellQuote(destination)}`,
        request.signal,
      );
    } catch (error) {
      await discardHiddenFiles(adb, [temp], "unfinished pushes");
      throw error;
    }
  }

  private async stagePreparedFiles(context: {
    adb: AdbExecutor;
    request: StageSharedStorageRequest;
    namespace: string;
    destinationDirectory: string;
    userId: number;
    files: PreparedSharedStorageFile[];
  }): Promise<StagedSharedStorageFile[]> {
    const { adb, request, namespace, destinationDirectory, userId, files } = context;
    const stagedFiles: StagedSharedStorageFile[] = [];
    const writtenPaths: string[] = [];
    // Destinations this batch will overwrite, keyed to the saved copy of their previous content.
    let backups: ReadonlyMap<string, string> = new Map();
    const markWritten = (path: string) => {
      if (!writtenPaths.includes(path)) {
        writtenPaths.push(path);
      }
    };
    let failedPath = "unknown destination";
    try {
      failedPath = "previous-content backup";
      backups = await this.saveBatchBackups(adb, destinationDirectory, files, request);
      for (const file of files) {
        failedPath = file.destinationPath;
        const staged = await this.stageFile({
          adb,
          request,
          namespace,
          destinationDirectory,
          userId,
          file,
          onBeforeCommit: () => {
            // Tracked before the rename so a rename whose outcome is unknown still restores the
            // original. The push itself never touches the destination, so it needs no tracking.
            if (backups.has(file.destinationPath)) {
              markWritten(file.destinationPath);
            }
          },
          onPushed: () => markWritten(file.destinationPath),
        });
        if (request.requireMediaIndexing && staged.mediaIndexing.status !== "completed") {
          throw new ActionableError(
            `MediaStore did not index ${staged.destinationPath}: ${staged.mediaIndexing.reason ?? "indexing was not completed"}`,
          );
        }
        stagedFiles.push(staged);
      }
      // The whole batch committed, so the saved previous contents are no longer needed.
      await discardHiddenFiles(adb, [...backups.values()], "previous-content backups");
      return stagedFiles;
    } catch (error) {
      if (!request.rollbackOnFailure) {
        throw error;
      }
      const rollback = await rollbackStagedFiles({
        adb,
        destinationDirectory,
        writtenPaths,
        backups,
        userId,
        rescanRestored: request.indexMedia ?? true,
        timer: this.timer,
      });
      throw new ActionableError(
        `Android ${request.requireMediaIndexing ? "media-library" : "shared-storage"} batch staging failed for ${failedPath}: ${errorMessage(error)} ` +
          `Rolled back: ${rollback.rolledBack.length > 0 ? rollback.rolledBack.join(", ") : "none"}. ` +
          `Rollback failures: ${rollback.failures.length > 0 ? rollback.failures.join("; ") : "none"}.`,
        { cause: error },
      );
    }
  }

  private async saveBatchBackups(
    adb: AdbExecutor,
    destinationDirectory: string,
    files: PreparedSharedStorageFile[],
    request: StageSharedStorageRequest,
  ): Promise<ReadonlyMap<string, string>> {
    if (!shouldKeepPrevious(request, files.length)) {
      return new Map();
    }
    return saveExistingFiles(adb, this.planBackups(destinationDirectory, files), request.signal);
  }

  /** One hidden saved-copy path per destination, beside the destination it protects. */
  private planBackups(
    destinationDirectory: string,
    files: PreparedSharedStorageFile[],
  ): BackupPlan[] {
    return files.map((file) => {
      const destination = posix.join(destinationDirectory, file.destinationPath);
      return {
        path: file.destinationPath,
        destination,
        // Dot-prefixed with a non-media extension so MediaStore never lists the saved copy.
        backup: posix.join(
          posix.dirname(destination),
          `.automobile-${this.idGenerator.next()}.bak`,
        ),
      };
    });
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
    try {
      const path = join(directory, "content");
      await this.fileSystem.writeFileBuffer(path, buffer);
      return { path, byteCount: buffer.byteLength, cleanup: () => this.fileSystem.rm(directory) };
    } catch (error) {
      try {
        await this.fileSystem.rm(directory);
      } catch (cleanupError) {
        // Cleanup failure must not mask the original preparation error.
        logger.warn(
          `Failed to remove inline shared-storage directory: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }
      throw error;
    }
  }
}

interface BackupPlan {
  path: string;
  destination: string;
  backup: string;
}

/** A single file has no earlier file to roll back, and a reset leaves nothing to overwrite. */
function shouldKeepPrevious(request: StageSharedStorageRequest, fileCount: number): boolean {
  return request.rollbackOnFailure === true && fileCount > 1 && !request.reset;
}

interface PreparedSharedStorageFile {
  destinationPath: string;
  source: { path: string; byteCount: number; cleanup?: () => Promise<void> };
}

async function rollbackStagedFiles(context: {
  adb: AdbExecutor;
  destinationDirectory: string;
  writtenPaths: string[];
  backups: ReadonlyMap<string, string>;
  userId: number;
  /** Rescan restored media files so MediaStore stops describing the overwritten bytes. */
  rescanRestored: boolean;
  timer: Timer;
}): Promise<{ rolledBack: string[]; failures: string[] }> {
  const { adb, destinationDirectory, writtenPaths, backups, userId, rescanRestored, timer } =
    context;
  const result = await rollbackWrittenFiles(writtenPaths, timer, (chunk, signal, timeoutMs) => {
    const created: string[] = [];
    const restores: string[] = [];
    for (const path of chunk) {
      const destination = posix.join(destinationDirectory, path);
      const backup = backups.get(path);
      if (backup === undefined) {
        created.push(shellQuote(destination));
        continue;
      }
      const restore = `mv -f ${shellQuote(backup)} ${shellQuote(destination)}`;
      restores.push(
        rescanRestored && shouldIndexMedia(path, true)
          ? `${restore} && ${mediaScanCommand(userId, destination)} >/dev/null`
          : restore,
      );
    }
    // Only destinations this batch created are deleted; overwritten ones get their content back.
    const command =
      restores.length === 0
        ? `shell rm -f ${created.join(" ")}`
        : `shell sh -c ${shellQuote(androidRollbackScript(created, restores))}`;
    return execute(adb, command, signal, timeoutMs);
  });
  // A saved copy of a file this batch never reached still sits beside an untouched original.
  await discardHiddenFiles(
    adb,
    [...backups].filter(([path]) => !writtenPaths.includes(path)).map(([, backup]) => backup),
    "previous-content backups",
  );
  return result;
}

/**
 * Saves the previous content of every destination that already exists as a regular file, in one
 * command per chunk. Returns the path-to-backup map for the ones that were copied; the rest did
 * not exist, so a rollback must delete rather than restore them.
 */
async function saveExistingFiles(
  adb: AdbExecutor,
  files: BackupPlan[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const saved = new Map<string, string>();
  for (
    let offset = 0;
    offset < files.length;
    offset += SHARED_STORAGE_ROLLBACK_MAX_PATHS_PER_COMMAND
  ) {
    const chunk = files.slice(offset, offset + SHARED_STORAGE_ROLLBACK_MAX_PATHS_PER_COMMAND);
    const script = androidStepsScript(
      chunk.map((file, index) =>
        androidSaveBackupScript(
          file.destination,
          file.backup,
          `${SHARED_STORAGE_BACKUP_MARKER}:${index}`,
        ),
      ),
    );
    try {
      const result = await executeResult(adb, `shell sh -c ${shellQuote(script)}`, signal);
      for (const [path, backup] of copiedBackups(chunk, result.stdout)) {
        saved.set(path, backup);
      }
    } catch (error) {
      // No destination has been touched yet; only partial copies can linger, and a truncated
      // copy must never be restored, so every candidate is removed rather than registered.
      await discardHiddenFiles(
        adb,
        files.map((file) => file.backup),
        "previous-content backups",
      );
      throw error;
    }
  }
  return saved;
}

/** The path-to-backup pairs whose copy the probe script confirmed with its per-file marker. */
function copiedBackups(chunk: BackupPlan[], stdout: string): Array<[string, string]> {
  const markers = new Set(stdout.split(/\r?\n/).map((line) => line.trim()));
  return chunk
    .filter((_, index) => markers.has(`${SHARED_STORAGE_BACKUP_MARKER}:${index}`))
    .map((file) => [file.path, file.backup]);
}

/** Removes hidden saved-copy or in-flight files, detached from the caller's cancellation. Never throws. */
async function discardHiddenFiles(adb: AdbExecutor, paths: string[], what: string): Promise<void> {
  await runWithAbortSignal(undefined, async () => {
    for (
      let offset = 0;
      offset < paths.length;
      offset += SHARED_STORAGE_ROLLBACK_MAX_PATHS_PER_COMMAND
    ) {
      const chunk = paths.slice(offset, offset + SHARED_STORAGE_ROLLBACK_MAX_PATHS_PER_COMMAND);
      try {
        await execute(
          adb,
          `shell rm -f ${chunk.map(shellQuote).join(" ")}`,
          undefined,
          SHARED_STORAGE_ROLLBACK_COMMAND_TIMEOUT_MS,
        );
      } catch (error) {
        // The write itself already finished or failed on its own terms; a stray hidden file
        // must not replace that outcome, so it is logged and left for the user to remove.
        logger.warn(`[SharedStorage] Left hidden ${what} behind: ${chunk.join(", ")}`, error);
      }
    }
  });
}

/** Shared bounded, cancellation-detached rollback contract for Android file batches. */
export async function rollbackWrittenFiles(
  writtenPaths: string[],
  timer: Timer,
  removePaths: (paths: string[], signal: AbortSignal, timeoutMs: number) => Promise<unknown>,
): Promise<{ rolledBack: string[]; failures: string[] }> {
  return runWithAbortSignal(undefined, async () => {
    const rolledBack: string[] = [];
    const failures: string[] = [];
    const deadline = timer.now() + SHARED_STORAGE_ROLLBACK_TOTAL_TIMEOUT_MS;
    const reversePaths = [...writtenPaths].reverse();
    for (
      let offset = 0;
      offset < reversePaths.length;
      offset += SHARED_STORAGE_ROLLBACK_MAX_PATHS_PER_COMMAND
    ) {
      const chunk = reversePaths.slice(
        offset,
        offset + SHARED_STORAGE_ROLLBACK_MAX_PATHS_PER_COMMAND,
      );
      const remainingMs = Math.max(0, deadline - timer.now());
      const timeoutMs = Math.min(SHARED_STORAGE_ROLLBACK_COMMAND_TIMEOUT_MS, remainingMs);
      const cleanup = new AbortController();
      try {
        if (remainingMs === 0) {
          throw new ActionableError(
            `Shared-storage batch rollback exceeded total timeout of ${SHARED_STORAGE_ROLLBACK_TOTAL_TIMEOUT_MS}ms`,
          );
        }
        await raceWithDeadline(() => removePaths(chunk, cleanup.signal, timeoutMs), {
          timer,
          timeoutMs,
          signal: cleanup.signal,
          label: "Shared-storage batch rollback",
          onTimeout: () => cleanup.abort(),
        });
        rolledBack.push(...chunk);
      } catch (error) {
        // A failed command may have removed some paths; none have confirmed success.
        // execFile embeds every command argument in its first line; keep diagnostics,
        // but bound the reason independently of the complete list of failed paths.
        const reason = errorMessage(error).replace(/Command failed:[^\r\n]*/g, "Command failed");
        const shortReason = reason.length > 256 ? `${truncateBodyText(reason, 253)}...` : reason;
        failures.push(`${chunk.join(", ")}: ${shortReason}`);
        logger.warn(
          `[SharedStorage] Failed to roll back staged media files ${chunk.join(", ")}`,
          error,
        );
      }
    }
    return { rolledBack, failures };
  });
}

async function execute(
  adb: AdbExecutor,
  command: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  try {
    await adb.executeCommand(command, timeoutMs, undefined, true, signal, true);
  } catch (error) {
    throw new ActionableError(`Android shared-storage operation failed: ${errorMessage(error)}`);
  }
}

async function executeArgs(
  adb: AdbExecutor,
  args: string[],
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  try {
    await adb.execute(args, {
      noRetry: true,
      signal,
      waitForProcessSettlementAfterAbort: true,
      timeoutMs,
    });
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
  await execute(adb, `shell ${mediaScanCommand(userId, destination)}`, signal);
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

/**
 * `file://` URI for an absolute device path. Each segment is percent-encoded so a space, `#`, `?`
 * or `%` in a file name stays part of the path; `/` separators are kept. A lone surrogate cannot be
 * encoded (it throws), so it becomes U+FFFD first.
 */
function fileUriFor(absolutePath: string): string {
  const segments = absolutePath.split("/");
  return `file://${segments.map((segment) => encodeURIComponent(segment.toWellFormed())).join("/")}`;
}

function mediaScanCommand(userId: number, destination: string): string {
  return `am broadcast --user ${userId} -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellQuote(fileUriFor(destination))}`;
}

async function executeResult(adb: AdbExecutor, command: string, signal?: AbortSignal) {
  try {
    return await adb.executeCommand(command, undefined, undefined, true, signal, true);
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
