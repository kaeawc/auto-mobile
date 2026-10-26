import {
  resolveOwnAppDataContainer,
  SimulatorContainerUnresolvedError,
  type SimulatorContainerOwnershipOptions,
} from "../utils/ios-cmdline-tools/simulatorOwnContainer";
import {
  type AppFileFileSystem,
  type AppFileListProvider,
  type AppFileProviderListRequest,
  type AppFileProviderReadRequest,
  type AppFileProviderWriteResult,
  type AppFileReadProvider,
  type AppFileSimCtl,
  type AppFileStats,
  type AppFileWriteProvider,
  type PutAppFileProviderRequest,
} from "./appFileService";
import { ActionableError, BootedDevice, toActionableError } from "../models";
import {
  decodeUtf8Text,
  executeIosAppContainerCommand,
  iosContainerRelativePath,
  leftoverBackupsWarning,
  listLocalFiles,
  requireAppContainersTarget,
  unsupportedAppFileOperation,
  writeIosFileAtomically,
} from "./appFileSupport";
import { basename, dirname, join } from "node:path";
import {
  AppFileContainer,
  AppFileListResult,
  AppFileReadResult,
  buildAppFileResourceUri,
  normalizeAppFileRelativePath,
} from "./appFileContract";
import { findIosSimulatorAppProcess } from "../features/action/CrashApp";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { shellQuote } from "../utils/shellQuote";

interface IosWrittenFile {
  target: string;
  destinationPath: string;
  /** Copy of the content this write replaced; absent when the destination was newly created. */
  backup?: string;
  preexisting: boolean;
}

export class IosSimulatorAppFileProvider
  implements AppFileWriteProvider, AppFileListProvider, AppFileReadProvider
{
  readonly platform = "ios" as const;
  readonly domain = "app_containers" as const;
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private tempIndex = 0;

  constructor(
    private readonly simctlFactory: (device: BootedDevice) => AppFileSimCtl,
    private readonly fileSystem: AppFileFileSystem,
    private readonly ownership: SimulatorContainerOwnershipOptions = {},
  ) {}

  async putFile(request: PutAppFileProviderRequest): Promise<AppFileProviderWriteResult> {
    return (await this.putFiles([request]))[0]!;
  }

  async putFiles(requests: PutAppFileProviderRequest[]): Promise<AppFileProviderWriteResult[]> {
    const roots = new Map<string, string>();
    const targets: string[] = [];
    for (const request of requests) {
      const appTarget = requireAppContainersTarget(request.target);
      const key = JSON.stringify([request.device.deviceId, appTarget.appId, appTarget.container]);
      let root = roots.get(key);
      if (root === undefined) {
        root = await this.resolveContainerRoot(
          request.device,
          appTarget.appId,
          appTarget.container,
          "putFile",
        );
        roots.set(key, root);
      }
      targets.push(join(root, normalizeAppFileRelativePath(request.destinationPath)));
    }
    const leftoverBackups = await this.writeBatch(requests, targets);
    // Keep confirmation separate from container resolution and atomic writes.
    const runningStates = new Map<string, boolean | undefined>();
    for (const request of requests) {
      const appTarget = requireAppContainersTarget(request.target);
      const key = JSON.stringify([request.device.deviceId, appTarget.appId]);
      if (runningStates.has(key)) {
        continue;
      }
      try {
        const output = await this.simctlFactory(request.device).executeCommandArgs(
          ["spawn", request.device.deviceId, "launchctl", "list"],
          5_000,
          request.signal,
        );
        const process = findIosSimulatorAppProcess(output.stdout, appTarget.appId);
        if (process) {
          runningStates.set(key, true);
        } else if (/^PID\s+Status\s+Label\s*$/m.test(output.stdout)) {
          runningStates.set(key, false);
        } else {
          logger.warn(
            `Unable to read iOS running state for ${appTarget.appId}: unparseable launchctl output`,
          );
          runningStates.set(key, undefined);
        }
      } catch (error) {
        // A failed or aborted optional check cannot undo a completed file write.
        logger.warn(
          `Failed to check iOS running state for ${appTarget.appId}: ${errorMessage(error)}`,
          error,
        );
        runningStates.set(key, undefined);
      }
    }
    const warning =
      leftoverBackups.length > 0 ? leftoverBackupsWarning(leftoverBackups) : undefined;
    return requests.map((request, index) => ({
      appRunning: runningStates.get(
        JSON.stringify([request.device.deviceId, requireAppContainersTarget(request.target).appId]),
      ),
      ...(index === 0 && warning !== undefined ? { warning } : {}),
    }));
  }

  /**
   * Writes every file, waits for all of them to settle, and on any failure undoes the ones this
   * call committed so the container keeps its pre-call state (matching the Android provider).
   */
  private async writeBatch(
    requests: PutAppFileProviderRequest[],
    targets: string[],
  ): Promise<string[]> {
    const outcomes = await Promise.allSettled(
      // A single-file write has no earlier file to roll back, so it needs no backup.
      requests.map((request, index) =>
        this.writeFile(request, targets[index]!, requests.length > 1),
      ),
    );
    const written: IosWrittenFile[] = [];
    let failure: { reason: unknown; destinationPath: string } | undefined;
    for (const [index, outcome] of outcomes.entries()) {
      const destinationPath = requests[index]!.destinationPath;
      if (outcome.status === "fulfilled") {
        written.push({ ...outcome.value, destinationPath });
      } else if (failure === undefined) {
        failure = { reason: outcome.reason, destinationPath };
      }
    }
    if (failure === undefined) {
      return await this.discardBackups(written);
    }
    if (written.length === 0) {
      // Nothing was committed, so there is nothing to undo; keep the original error.
      throw failure.reason;
    }
    const rollback = await this.rollbackWrites(written);
    const list = (entries: string[]) => (entries.length > 0 ? entries.join(", ") : "none");
    throw new ActionableError(
      `iOS app-container batch write failed for ${failure.destinationPath}: ${errorMessage(failure.reason)} ` +
        `Rolled back: ${list(rollback.rolledBack)}. ` +
        `Left modified (previous content not restored): ${list(rollback.leftModified)}. ` +
        `Rollback failures: ${rollback.failures.join("; ") || "none"}.`,
      { cause: failure.reason },
    );
  }

  private async rollbackWrites(written: IosWrittenFile[]): Promise<{
    rolledBack: string[];
    leftModified: string[];
    failures: string[];
  }> {
    const rolledBack: string[] = [];
    const leftModified: string[] = [];
    const failures: string[] = [];
    for (const file of [...written].reverse()) {
      try {
        if (file.backup !== undefined) {
          await this.fileSystem.rename(file.backup, file.target);
        } else if (file.preexisting) {
          // Existed but could not be copied aside (not a regular file); never delete it.
          leftModified.push(file.destinationPath);
          continue;
        } else {
          await this.fileSystem.rm(file.target);
        }
        rolledBack.push(file.destinationPath);
      } catch (error) {
        failures.push(`${file.destinationPath}: ${errorMessage(error)}`);
        logger.warn(
          `Failed to roll back iOS app file ${file.target}: ${errorMessage(error)}`,
          error,
        );
      }
    }
    return { rolledBack, leftModified, failures };
  }

  /** Returns the backup paths that could not be removed. */
  private async discardBackups(written: IosWrittenFile[]): Promise<string[]> {
    const leftover: string[] = [];
    for (const file of written) {
      if (file.backup === undefined) {
        continue;
      }
      try {
        await this.fileSystem.rm(file.backup);
      } catch (error) {
        leftover.push(file.backup);
        // The write already succeeded; a stray hidden backup must not fail it.
        logger.warn(
          `Failed to remove iOS app file backup ${file.backup}: ${errorMessage(error)}`,
          error,
        );
      }
    }
    return leftover;
  }

  private async writeFile(
    request: PutAppFileProviderRequest,
    target: string,
    keepPrevious: boolean,
  ): Promise<{ target: string; backup?: string; preexisting: boolean }> {
    const run = async () => {
      const previous = keepPrevious ? await this.saveExisting(target) : { preexisting: false };
      try {
        await writeIosFileAtomically(this.fileSystem, request.sourcePath, target, ++this.tempIndex);
      } catch (error) {
        if (previous.backup !== undefined) {
          await this.discardBackups([{ ...previous, target, destinationPath: target }]);
        }
        throw error;
      }
      return { target, ...previous };
    };
    const earlier = this.pendingWrites.get(target);
    const write = earlier ? earlier.then(run, run) : run();
    const settled = write.then(() => undefined);
    this.pendingWrites.set(target, settled);
    const clear = () => {
      if (this.pendingWrites.get(target) === settled) {
        this.pendingWrites.delete(target);
      }
    };
    void settled.then(clear, clear);
    return await write;
  }

  /** Copies a file this write is about to replace aside so a failed batch can restore it. */
  private async saveExisting(target: string): Promise<{ backup?: string; preexisting: boolean }> {
    let stats: AppFileStats;
    try {
      stats = await this.fileSystem.lstat(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { preexisting: false };
      }
      throw toActionableError(error, `Failed to inspect existing iOS app file at ${target}`);
    }
    if (!stats.isFile()) {
      return { preexisting: true };
    }
    const backup = join(dirname(target), `.${basename(target)}.${++this.tempIndex}.bak`);
    try {
      await this.fileSystem.copyFile(target, backup);
    } catch (error) {
      await this.discardBackups([{ target, destinationPath: target, backup, preexisting: true }]);
      throw error;
    }
    return { backup, preexisting: true };
  }

  async listFiles(request: AppFileProviderListRequest): Promise<AppFileListResult> {
    const root = await this.resolvePath(
      request.device,
      request.appId,
      request.container,
      undefined,
      "listFiles",
    );
    const files = await listLocalFiles(root, this.fileSystem);
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
        }),
      })),
    };
  }

  async readFile(request: AppFileProviderReadRequest): Promise<AppFileReadResult> {
    const target = await this.resolvePath(
      request.device,
      request.appId,
      request.container,
      request.path,
      "readFile",
    );
    const buffer = await this.fileSystem.readFileBuffer(target);
    const text = decodeUtf8Text(buffer);
    return {
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      path: request.path,
      byteCount: buffer.byteLength,
      ...(text === undefined
        ? { mimeType: "application/octet-stream", blob: buffer.toString("base64") }
        : { mimeType: "text/plain; charset=utf-8", text }),
    };
  }

  private async resolvePath(
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
    path: string | undefined,
    operation: string,
  ): Promise<string> {
    const containerRoot = await this.resolveContainerRoot(device, appId, container, operation);
    return path === undefined
      ? containerRoot
      : join(containerRoot, normalizeAppFileRelativePath(path));
  }

  private async resolveContainerRoot(
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
    operation: string,
  ): Promise<string> {
    if (container === "externalFiles") {
      throw unsupportedAppFileOperation(
        operation,
        device.platform,
        appId,
        container,
        "externalFiles is not available for iOS app containers",
      );
    }

    if (resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator") {
      throw new ActionableError(
        `iOS app file ${operation} is only supported on iOS simulators. ` +
          `Device ${device.deviceId} looks like a physical iOS device; app data containers require xcrun simctl.`,
      );
    }

    const simctl = this.simctlFactory(device);
    let dataRoot: string;
    try {
      dataRoot = await resolveOwnAppDataContainer({
        ...this.ownership,
        deviceId: device.deviceId,
        bundleId: appId,
        run: (args) =>
          executeIosAppContainerCommand(simctl, args.map(shellQuote).join(" "), {
            device,
            appId,
            container,
            operation,
          }),
      });
    } catch (error) {
      if (error instanceof SimulatorContainerUnresolvedError) {
        throw new ActionableError(
          `Unable to resolve iOS simulator app data container for ${appId} on ${device.deviceId}. ` +
            "Confirm the simulator is booted and the app is installed.",
        );
      }
      throw error;
    }

    return join(dataRoot, iosContainerRelativePath(container, operation, appId, device.platform));
  }
}
