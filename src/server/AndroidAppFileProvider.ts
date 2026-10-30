import { type AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  type AppFileListProvider,
  type AppFileProviderListRequest,
  type AppFileProviderReadRequest,
  type AppFileProviderWriteResult,
  type AppFileReadProvider,
  type AppFileServiceDependencies,
  type AppFileWriteProvider,
  type ForegroundAppLookup,
  type PutAppFileProviderRequest,
} from "./appFileService";
import { ActionableError, BootedDevice, toActionableError } from "../models";
import { AndroidUserTargetResolver } from "../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { isPackageInstalledForUser } from "../utils/android-cmdline-tools/isPackageInstalledForUser";
import { logger } from "../utils/logger";
import { shellQuote } from "../utils/shellQuote";
import {
  AppContainersTarget,
  AppFileListResult,
  AppFileReadResult,
  buildAppFileResourceUri,
} from "./appFileContract";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { type AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  ANDROID_APP_FILE_MAX_BUFFER,
  APP_FILE_BACKUP_DISCARD_CHUNK,
  APP_FILE_BACKUP_MARKER,
  APP_FILE_DIRECTORY_MARKER,
  APP_FILE_STAGING_CLEANUP_COMMAND_TIMEOUT_MS,
  decodeUtf8Text,
  directoryDestinationError,
  executeAndroidAppFileCommand,
  leftoverBackupsWarning,
  parseAndroidStatListing,
  requireAppContainersTarget,
  resolveAndroidTarget,
  unsupportedAppFileOperation,
} from "./appFileSupport";
import { errorMessage } from "../utils/describeUnknownError";
import { readAndroidPackageProcesses } from "../utils/android-cmdline-tools/androidProcessState";
import { rollbackWrittenFiles } from "./sharedStorageService";
import {
  androidRestoreBackupScript,
  androidRollbackScript,
  androidSaveBackupScript,
} from "./androidFileBackup";
import { posix } from "node:path";
import { APP_FILE_PUSH_TIMEOUT_MS } from "../features/storage/fileTransferTimeout";
import { runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";

interface AndroidAppFileUser {
  userId: number;
  pinInResourceUri: boolean;
}

/** The caller's requested user (if any) and cancellation for one user resolution. */
interface AndroidAppFileUserRequest {
  userId?: number;
  signal?: AbortSignal;
}

// Explicit IDs (including 0) always round-trip. Auto-resolved 0 is pinned only
// when several users have the app installed; a sole user-0 installation keeps
// its existing query-free URI. Nonzero resolved users are always pinned.
async function resolveAndroidAppFileUser(
  adb: AdbExecutor,
  foregroundAppLookup: ForegroundAppLookup,
  device: BootedDevice,
  appId: string,
  { userId, signal }: AndroidAppFileUserRequest,
): Promise<AndroidAppFileUser> {
  const resolver = new AndroidUserTargetResolver(adb);
  if (userId !== undefined) {
    if (!Number.isSafeInteger(userId) || userId < 0) {
      throw new ActionableError("Android userId must be a non-negative safe integer.");
    }
    return {
      userId: (await resolver.resolve({ explicitUserId: userId, signal })).userId,
      pinInResourceUri: true,
    };
  }

  try {
    // Once per operation/batch: listUsers + one pm list per user. A user-0-only
    // device needs just those two reads; foreground/current probes are only for ambiguity.
    const users = await adb.listUsers(signal);
    if (users.length === 0) {
      throw new ActionableError(
        `Android user resolution failed for ${appId} on ${device.deviceId}: no users could be determined. Pass userId explicitly (resource query ?userId=N).`,
      );
    }
    let candidates: number[] = [];
    for (const user of users) {
      if (await isPackageInstalledForUser(adb, appId, user.userId, undefined, signal)) {
        candidates.push(user.userId);
      }
    }
    const runningCandidates = users
      .filter((user) => user.running && candidates.includes(user.userId))
      .map((user) => user.userId);
    if (runningCandidates.length > 0) {
      candidates = runningCandidates;
    }
    // With no running candidates, preserve selection: run-as behavior for stopped
    // users is unverified and needs a device capture.
    if (candidates.length === 1) {
      return { userId: candidates[0]!, pinInResourceUri: candidates[0] !== 0 };
    }
    if (candidates.length === 0) {
      throw new ActionableError(
        `Android app ${appId} is not installed for any user on ${device.deviceId}. Install the app for the intended user.`,
      );
    }
    return await resolveAmbiguousAndroidAppFileUser(adb, foregroundAppLookup, device, appId, {
      candidates,
      signal,
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw toActionableError(
      error,
      `Android user resolution failed for ${appId} on ${device.deviceId}. Pass userId explicitly (resource query ?userId=N)`,
    );
  }
}

async function resolveAmbiguousAndroidAppFileUser(
  adb: AdbExecutor,
  foregroundAppLookup: ForegroundAppLookup,
  device: BootedDevice,
  appId: string,
  { candidates, signal }: { candidates: number[]; signal?: AbortSignal },
): Promise<AndroidAppFileUser> {
  try {
    const foreground = await foregroundAppLookup.getForegroundApp(signal);
    if (foreground?.packageName === appId && candidates.includes(foreground.userId)) {
      return { userId: foreground.userId, pinInResourceUri: true };
    }
  } catch (error) {
    signal?.throwIfAborted();
    // Foreground lookup is an optional refinement; current-user resolution remains available.
    logger.debug("Android app-file foreground lookup failed", error);
  }
  const current = await new AndroidUserTargetResolver(adb).resolve({ currentUser: true, signal });
  if (current.source === "currentUser" && candidates.includes(current.userId)) {
    return { userId: current.userId, pinInResourceUri: true };
  }
  throw new ActionableError(
    `Android app ${appId} on ${device.deviceId} is installed for candidate users ${candidates.join(", ")}, but no installed foreground user could be selected. Pass userId explicitly (resource query ?userId=N).`,
  );
}

/** How one file write of a batch reports back to the batch's rollback bookkeeping. */
interface AndroidAppFileWriteTracking {
  onWritten: (backup: string | undefined) => void;
  cleanupFailures: string[];
  keepPrevious: boolean;
}

function androidRunAsPrefix(appId: string, userId: number): string {
  // AOSP run-as grammar: usage: run-as <package-name> [--user <uid>] <command> [<args>] (system/core/run-as/run-as.cpp), so --user follows the package name.
  return `shell run-as ${shellQuote(appId)}${userId ? ` --user ${userId}` : ""}`;
}

function androidAppFilePrefix(appTarget: AppContainersTarget, userId: number): string {
  return appTarget.container === "externalFiles"
    ? "shell"
    : androidRunAsPrefix(appTarget.appId, userId);
}

export class AndroidAppFileProvider
  implements AppFileWriteProvider, AppFileListProvider, AppFileReadProvider
{
  readonly platform = "android" as const;
  readonly domain = "app_containers" as const;
  private readonly idGenerator: IdGenerator;
  private readonly foregroundAppLookup?: ForegroundAppLookup;
  private readonly timer: Timer;

  constructor(
    private readonly adbFactory: AdbClientFactory,
    options: Pick<AppFileServiceDependencies, "idGenerator" | "foregroundAppLookup" | "timer"> = {},
  ) {
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.foregroundAppLookup = options.foregroundAppLookup;
    this.timer = options.timer ?? defaultTimer;
  }

  async putFile(request: PutAppFileProviderRequest): Promise<AppFileProviderWriteResult> {
    return (await this.putFiles([request]))[0]!;
  }

  async putFiles(requests: PutAppFileProviderRequest[]): Promise<AppFileProviderWriteResult[]> {
    if (requests.length === 0) {
      return [];
    }
    const request = requests[0]!;
    const appTarget = requireAppContainersTarget(request.target);
    const target = resolveAndroidTarget(
      appTarget.appId,
      appTarget.container,
      request.destinationPath,
    );
    if (target.kind === "unsupported") {
      throw unsupportedAppFileOperation(
        "putFile",
        request.device.platform,
        appTarget.appId,
        appTarget.container,
        target.message,
      );
    }
    const adb = this.adbFactory.create(request.device);
    const { userId, pinInResourceUri } = await resolveAndroidAppFileUser(
      adb,
      this.foregroundAppLookup ?? adb,
      request.device,
      appTarget.appId,
      { userId: request.userId, signal: request.signal },
    );
    const results: AppFileProviderWriteResult[] = [];
    const writtenPaths: string[] = [];
    // Destinations this batch overwrote, keyed to the backup of their previous content.
    const backups = new Map<string, string>();
    const cleanupFailures: string[] = [];
    let failedPath = request.destinationPath;
    try {
      for (const file of requests) {
        failedPath = file.destinationPath;
        await this.writeFile(file, adb, userId, {
          onWritten: (backup) => {
            writtenPaths.push(file.destinationPath);
            if (backup !== undefined) {
              backups.set(file.destinationPath, backup);
            }
          },
          cleanupFailures,
          // A single-file write has no earlier file to roll back, so it needs no backup.
          keepPrevious: requests.length > 1,
        });
        if (cleanupFailures.length > 0) {
          throw new ActionableError("Android app-file staging cleanup failed.");
        }
        results.push({ resourceUserId: pinInResourceUri ? userId : undefined });
      }
    } catch (error) {
      const rollback = await this.rollbackFiles(adb, appTarget, userId, writtenPaths, backups);
      throw new ActionableError(
        `Android app-container batch staging failed for ${failedPath}: ${errorMessage(error)} ` +
          `Rolled back: ${rollback.rolledBack.length > 0 ? rollback.rolledBack.join(", ") : "none"}. ` +
          `Rollback failures: ${[...rollback.failures, ...cleanupFailures].join("; ") || "none"}.`,
        { cause: error },
      );
    }
    const leftover = await this.discardBackups(adb, appTarget, userId, [...backups.values()]);
    await this.confirmRunningState(adb, request, appTarget, userId, results);
    if (leftover.length > 0) {
      results[0] = { ...results[0], warning: leftoverBackupsWarning(leftover) };
    }
    return results;
  }

  /**
   * The whole batch committed, so the saved previous contents are no longer needed. Returns the
   * backups that could not be removed (the write already succeeded; they must not fail it).
   */
  private async discardBackups(
    adb: AdbExecutor,
    appTarget: AppContainersTarget,
    userId: number,
    backups: string[],
  ): Promise<string[]> {
    const leftover: string[] = [];
    const prefix = androidAppFilePrefix(appTarget, userId);
    for (let offset = 0; offset < backups.length; offset += APP_FILE_BACKUP_DISCARD_CHUNK) {
      const chunk = backups.slice(offset, offset + APP_FILE_BACKUP_DISCARD_CHUNK);
      const failures: string[] = [];
      await this.cleanupStaging(
        adb,
        [`${prefix} rm -f ${chunk.map(shellQuote).join(" ")}`],
        "previous-content backups",
        failures,
      );
      if (failures.length > 0) {
        logger.warn(`Left Android app-file backups behind: ${failures.join("; ")}`);
        leftover.push(...chunk);
      }
    }
    return leftover;
  }

  private async confirmRunningState(
    adb: AdbExecutor,
    request: PutAppFileProviderRequest,
    appTarget: AppContainersTarget,
    userId: number,
    results: AppFileProviderWriteResult[],
  ): Promise<void> {
    try {
      const state = await readAndroidPackageProcesses(adb, appTarget.appId, {
        userId,
        signal: request.signal,
        timer: this.timer,
      });
      if (state.isRunning) {
        for (const result of results) {
          result.appRunning = true;
        }
      } else if (
        state.processes.length === 0 &&
        !state.stdout.includes("ACTIVITY MANAGER RUNNING PROCESSES")
      ) {
        logger.warn(
          `Unable to read Android running state for ${appTarget.appId}: unparseable process output`,
        );
      }
    } catch (error) {
      // Running-state confirmation is best effort after the entire write has succeeded.
      logger.warn(
        `Failed to check Android running state for ${appTarget.appId}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private rollbackFiles(
    adb: AdbExecutor,
    appTarget: AppContainersTarget,
    userId: number,
    writtenPaths: string[],
    backups: ReadonlyMap<string, string>,
  ) {
    return rollbackWrittenFiles(writtenPaths, this.timer, (paths, signal, timeoutMs) => {
      const created: string[] = [];
      const restores: string[] = [];
      for (const path of paths) {
        const resolved = resolveAndroidTarget(appTarget.appId, appTarget.container, path, userId);
        if (resolved.kind === "unsupported") {
          throw new ActionableError(resolved.message);
        }
        const destination = shellQuote(
          resolved.kind === "external" ? resolved.absolutePath : resolved.relativePath,
        );
        const backup = backups.get(path);
        if (backup === undefined) {
          created.push(destination);
        } else {
          restores.push(`mv -f ${shellQuote(backup)} ${destination}`);
        }
      }
      const prefix = androidAppFilePrefix(appTarget, userId);
      // Only destinations this batch created are deleted; overwritten ones get their content back.
      const command =
        restores.length === 0
          ? `${prefix} rm -f ${created.join(" ")}`
          : `${prefix} sh -c ${shellQuote(androidRollbackScript(created, restores))}`;
      return adb.executeCommand(command, {
        timeoutMs,
        noRetry: true,
        signal,
        waitForProcessSettlementAfterAbort: true,
      });
    });
  }

  private async writeFile(
    request: PutAppFileProviderRequest,
    adb: AdbExecutor,
    userId: number,
    { onWritten, cleanupFailures, keepPrevious }: AndroidAppFileWriteTracking,
  ): Promise<void> {
    const appTarget = requireAppContainersTarget(request.target);
    const target = resolveAndroidTarget(
      appTarget.appId,
      appTarget.container,
      request.destinationPath,
      userId,
    );
    if (target.kind === "unsupported") {
      throw unsupportedAppFileOperation(
        "putFile",
        request.device.platform,
        appTarget.appId,
        appTarget.container,
        target.message,
      );
    }
    const prefix =
      target.kind === "external" ? "shell" : androidRunAsPrefix(appTarget.appId, userId);
    const destination = target.kind === "external" ? target.absolutePath : target.relativePath;
    const token = this.idGenerator.next();
    const temporary = posix.join(posix.dirname(destination), `.automobile-${token}.tmp`);
    const backup = posix.join(posix.dirname(destination), `.automobile-${token}.bak`);
    const staging =
      target.kind === "external"
        ? temporary
        : `/data/local/tmp/automobile-${token}-${posix.basename(request.destinationPath)}`;
    const context = {
      device: request.device,
      appId: appTarget.appId,
      container: appTarget.container,
      operation: "write" as const,
      userId,
      access: target.kind === "external" ? ("externalFiles" as const) : ("run-as" as const),
    };
    // Save the previous content before it is replaced so a failed batch can restore it. The copy
    // goes to a `.part` file and is renamed into place, so the backup path only ever exists
    // complete: a failed or killed `cp` leaves the original untouched and at most a `.part`.
    const saveBackup = keepPrevious
      ? `${androidSaveBackupScript(destination, backup, APP_FILE_BACKUP_MARKER)} && `
      : "";
    const cleanupCommands = [
      ...(target.kind === "external" ? [] : [`shell rm -f ${shellQuote(staging)}`]),
      `${prefix} rm -f ${shellQuote(temporary)}`,
    ];
    let restoreOnFailure = keepPrevious;
    try {
      if (target.kind === "external") {
        await executeAndroidAppFileCommand(
          adb,
          `shell mkdir -p ${shellQuote(posix.dirname(destination))}`,
          context,
          { noRetry: true, signal: request.signal },
        );
      }
      await executeAndroidAppFileCommand(
        adb,
        `push ${shellQuote(request.sourcePath)} ${shellQuote(staging)}`,
        context,
        { noRetry: true, signal: request.signal, timeoutMs: APP_FILE_PUSH_TIMEOUT_MS },
      );
      const replace = `mv -f ${shellQuote(temporary)} ${shellQuote(destination)}`;
      // `mv -f <file> <directory>` moves the file INTO the directory and succeeds, so a
      // directory destination must be refused before anything is staged or moved (#10349 D3).
      const refuseDirectory =
        `if [ -d ${shellQuote(destination)} ]; then ` +
        `echo ${APP_FILE_DIRECTORY_MARKER} >&2; exit 1; fi; `;
      const command =
        target.kind === "external"
          ? `${refuseDirectory}${saveBackup}${replace}`
          : `${refuseDirectory}mkdir -p ${shellQuote(posix.dirname(destination))} && ` +
            `cp ${shellQuote(staging)} ${shellQuote(temporary)} && ` +
            `chmod 600 ${shellQuote(temporary)} && ${saveBackup}${replace}`;
      const output = await executeAndroidAppFileCommand(
        adb,
        `${prefix} sh -c ${shellQuote(command)}`,
        context,
        { noRetry: true, signal: request.signal },
      ).catch((error: unknown) => {
        throw directoryDestinationError(error, request.destinationPath, appTarget.appId) ?? error;
      });
      restoreOnFailure = false;
      onWritten(output.stdout.includes(APP_FILE_BACKUP_MARKER) ? backup : undefined);
    } finally {
      if (restoreOnFailure) {
        // The failure's stdout is lost, so whether the backup completed is read from the device:
        // the backup path exists only after a complete copy. An ambiguous failure (e.g. a deadline
        // after the rename) must not strand the original in the backup, and restoring a complete
        // backup is a no-op when the destination was never replaced. A partial copy never reaches
        // the backup path, so the intact destination is left alone and only the `.part` is removed.
        cleanupCommands.push(
          `${prefix} sh -c ${shellQuote(androidRestoreBackupScript(destination, backup))}`,
        );
      }
      await this.cleanupStaging(adb, cleanupCommands, request.destinationPath, cleanupFailures);
    }
  }

  private async cleanupStaging(
    adb: AdbExecutor,
    commands: string[],
    destinationPath: string,
    failures: string[],
  ): Promise<void> {
    // Cleanup must outlive both explicit and ambient request cancellation.
    for (const command of commands) {
      const cleanup = new AbortController();
      try {
        await runWithAbortSignal(undefined, () =>
          raceWithDeadline(
            () =>
              adb.executeCommand(command, {
                timeoutMs: APP_FILE_STAGING_CLEANUP_COMMAND_TIMEOUT_MS,
                noRetry: true,
                signal: cleanup.signal,
                waitForProcessSettlementAfterAbort: true,
              }),
            {
              timer: this.timer,
              timeoutMs: APP_FILE_STAGING_CLEANUP_COMMAND_TIMEOUT_MS,
              label: "Android app-file staging cleanup",
              onTimeout: () => cleanup.abort(),
            },
          ),
        );
      } catch (error) {
        failures.push(`${destinationPath} staging cleanup (${command}): ${errorMessage(error)}`);
        logger.warn("Android app-file staging cleanup failed", error);
      }
    }
  }

  async listFiles(request: AppFileProviderListRequest): Promise<AppFileListResult> {
    const adb = this.adbFactory.create(request.device);
    let base = resolveAndroidTarget(request.appId, request.container, "placeholder");
    if (base.kind === "unsupported") {
      throw unsupportedAppFileOperation(
        "listFiles",
        request.device.platform,
        request.appId,
        request.container,
        base.message,
      );
    }

    const { userId, pinInResourceUri } = await resolveAndroidAppFileUser(
      adb,
      this.foregroundAppLookup ?? adb,
      request.device,
      request.appId,
      { userId: request.userId },
    );
    if (base.kind === "external" && userId !== 0) {
      const resolved = resolveAndroidTarget(
        request.appId,
        request.container,
        "placeholder",
        userId,
      );
      if (resolved.kind === "external") {
        base = resolved;
      }
    }

    const root =
      base.kind === "external"
        ? posix.dirname(base.absolutePath)
        : posix.dirname(base.relativePath);
    const script = `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -exec stat -c '%F|%s|%Y|%n' {} \\; ; fi`;
    const runAs = base.kind === "external" ? undefined : androidRunAsPrefix(request.appId, userId);
    const stdout =
      base.kind === "external"
        ? (
            await executeAndroidAppFileCommand(
              adb,
              `shell ${script}`,
              {
                device: request.device,
                appId: request.appId,
                container: request.container,
                operation: "list",
                userId,
                access: "externalFiles",
              },
              {
                maxBuffer: ANDROID_APP_FILE_MAX_BUFFER,
                noRetry: true,
                timeoutMs: APP_FILE_PUSH_TIMEOUT_MS,
              },
            )
          ).stdout
        : (
            await executeAndroidAppFileCommand(
              adb,
              `${runAs} sh -c ${shellQuote(script)}`,
              {
                device: request.device,
                appId: request.appId,
                container: request.container,
                operation: "list",
                userId,
                access: "run-as",
              },
              {
                maxBuffer: ANDROID_APP_FILE_MAX_BUFFER,
                noRetry: true,
                timeoutMs: APP_FILE_PUSH_TIMEOUT_MS,
              },
            )
          ).stdout;

    const files = parseAndroidStatListing(
      stdout,
      root,
      request.device,
      request.appId,
      request.container,
    );

    return {
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      files: files.map((file) => ({
        ...file,
        resourceUri: buildAppFileResourceUri({
          deviceId: request.device.deviceId,
          appId: request.appId,
          container: request.container,
          path: file.path,
          userId: pinInResourceUri ? userId : undefined,
        }),
      })),
    };
  }

  async readFile(request: AppFileProviderReadRequest): Promise<AppFileReadResult> {
    const adb = this.adbFactory.create(request.device);
    let target = resolveAndroidTarget(request.appId, request.container, request.path);
    if (target.kind === "unsupported") {
      throw unsupportedAppFileOperation(
        "readFile",
        request.device.platform,
        request.appId,
        request.container,
        target.message,
      );
    }

    const { userId } = await resolveAndroidAppFileUser(
      adb,
      this.foregroundAppLookup ?? adb,
      request.device,
      request.appId,
      { userId: request.userId },
    );
    if (target.kind === "external" && userId !== 0) {
      const resolved = resolveAndroidTarget(request.appId, request.container, request.path, userId);
      if (resolved.kind === "external") {
        target = resolved;
      }
    }

    const runAs =
      target.kind === "external" ? undefined : androidRunAsPrefix(request.appId, userId);
    const stdout =
      target.kind === "external"
        ? (
            await executeAndroidAppFileCommand(
              adb,
              `shell base64 ${shellQuote(target.absolutePath)}`,
              {
                device: request.device,
                appId: request.appId,
                container: request.container,
                operation: "read",
                userId,
                access: "externalFiles",
              },
              {
                maxBuffer: ANDROID_APP_FILE_MAX_BUFFER,
                noRetry: true,
                timeoutMs: APP_FILE_PUSH_TIMEOUT_MS,
              },
            )
          ).stdout
        : (
            await executeAndroidAppFileCommand(
              adb,
              `${runAs} base64 ${shellQuote(target.relativePath)}`,
              {
                device: request.device,
                appId: request.appId,
                container: request.container,
                operation: "read",
                userId,
                access: "run-as",
              },
              {
                maxBuffer: ANDROID_APP_FILE_MAX_BUFFER,
                noRetry: true,
                timeoutMs: APP_FILE_PUSH_TIMEOUT_MS,
              },
            )
          ).stdout;
    const blob = stdout.replace(/\s+/g, "");
    const buffer = Buffer.from(blob, "base64");
    const text = decodeUtf8Text(buffer);
    return {
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      path: request.path,
      byteCount: buffer.byteLength,
      ...(text === undefined
        ? { mimeType: "application/octet-stream", blob }
        : { mimeType: "text/plain; charset=utf-8", text }),
    };
  }
}
