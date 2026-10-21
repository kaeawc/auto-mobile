import { dirname, join, posix } from "node:path";
import { ActionableError, type BootedDevice } from "../models";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import type { Timer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { shellQuote } from "../utils/shellQuote";
import { normalizeAppFileRelativePath } from "./appFileContract";
import {
  executeIosAppContainerCommand,
  iosContainerRelativePath,
  listLocalFiles,
  type LocalFileListEntry,
} from "./appFileSupport";
import { type AppFileFileSystem } from "./appFileService";
import {
  boundedContent,
  failedPath,
  type SessionLogProvider,
  type SessionLogSimctl,
  type ResetAppLogsRequest,
} from "./DefaultSessionLogService";
import { SessionLogTimeoutError } from "./SessionLogTimeoutError";
import { logShowArgs, unifiedLogPredicate, unifiedLogWindowResult } from "./unifiedLogWindow";
import type {
  SessionLogAppGroupRequest,
  SessionLogAppGroupResult,
  SessionLogFileOutcome,
  SessionLogFilesRequest,
  SessionLogFilesResult,
  ResetAppLogsPathOutcome,
  UnifiedLogWindowRequest,
  UnifiedLogWindowResult,
} from "./sessionLogContract";

/** Same rotation convention as Android's `Log`/logback rotators: `<name>`, `<name>.1`, `<name>.2`, … */
function isRotatedSibling(name: string, base: string): boolean {
  return name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1));
}

// --- iOS Simulator ----------------------------------------------------------

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** A missing log file is an expected per-path outcome; anything else is a traced failure. */
function readOutcomeForError(path: string, target: string, error: unknown): SessionLogFileOutcome {
  if (isMissing(error)) {
    logger.debug(`[SessionLogService] log file missing: ${target}: ${error}`);
    return { path, status: "missing" };
  }
  logger.warn(`[SessionLogService] read ${target} failed: ${errorMessage(error)}`, error);
  return failedPath(path, error);
}

export class IosSimulatorSessionLogProvider implements SessionLogProvider {
  readonly platform = "ios" as const;

  constructor(
    private readonly simctlFactory: (device: BootedDevice) => SessionLogSimctl,
    private readonly fileSystem: AppFileFileSystem,
    private readonly timer: Timer,
    private readonly unifiedLogTimeoutMs: number,
  ) {}

  async readAppLogs(
    device: BootedDevice,
    appId: string,
    request: SessionLogFilesRequest,
    maxBytes: number,
  ): Promise<SessionLogFilesResult> {
    const root = await this.resolveContainerRoot(device, appId, request.container, "read", "data");
    const containerRoot = join(
      root,
      iosContainerRelativePath(request.container, "read", appId, device.platform),
    );
    const entries: SessionLogFileOutcome[] = [];
    for (const path of request.paths) {
      entries.push(await this.readBounded(containerRoot, path, maxBytes));
    }
    return { container: request.container, entries };
  }

  async resetAppLogs(request: ResetAppLogsRequest): Promise<ResetAppLogsPathOutcome[]> {
    const { device, appId, container } = request;
    const root = await this.resolveContainerRoot(device, appId, container, "reset", "data");
    const containerRoot = join(
      root,
      iosContainerRelativePath(container, "reset", appId, device.platform),
    );
    const entries: ResetAppLogsPathOutcome[] = [];
    for (const path of request.paths) {
      try {
        entries.push({ path, status: await this.resetOne(containerRoot, path) });
      } catch (error) {
        entries.push({ path, status: "failed", reason: errorMessage(error) });
      }
    }
    return entries;
  }

  async readAppGroup(
    device: BootedDevice,
    appId: string,
    request: SessionLogAppGroupRequest,
    maxBytes: number,
  ): Promise<SessionLogAppGroupResult> {
    const root = await this.resolveContainerRoot(
      device,
      appId,
      request.groupId,
      "read",
      request.groupId,
    );
    const files: LocalFileListEntry[] = await listLocalFiles(root, this.fileSystem);
    const entries: SessionLogFileOutcome[] = [];
    for (const path of request.paths) {
      entries.push(await this.readBounded(root, path, maxBytes));
    }
    return { groupId: request.groupId, files, entries };
  }

  async collectUnifiedLog(
    device: BootedDevice,
    appId: string,
    request: UnifiedLogWindowRequest,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<UnifiedLogWindowResult> {
    this.requireSimulator(device, "collect the unified log");
    const predicate = unifiedLogPredicate(appId, request.processName);
    const args = ["spawn", device.deviceId, "log", ...logShowArgs(request, predicate)];
    const startedAt = this.timer.now();
    const stdout = await this.runBounded(device, args, signal);
    return unifiedLogWindowResult(request, stdout, maxBytes, {
      predicate,
      mechanism: "simctl-log-show",
      collectionMs: this.timer.now() - startedAt,
      timeoutMs: this.unifiedLogTimeoutMs,
    });
  }

  /**
   * Run one `simctl spawn … log show` under the injected timer. The window is
   * bounded by the contract; this bounds the wall clock, aborting the child on
   * expiry so a wedged `log show` never pins the collection.
   */
  private async runBounded(
    device: BootedDevice,
    args: string[],
    callerSignal?: AbortSignal,
  ): Promise<string> {
    const simctl = this.simctlFactory(device);
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    // Arm the collection deadline before simctl so its typed timeout wins equal deadlines.
    const run = () => simctl.executeCommandArgs(args, this.unifiedLogTimeoutMs, signal);
    let timeoutError: SessionLogTimeoutError | undefined;
    return (
      await raceWithDeadline(run, {
        timer: this.timer,
        timeoutMs: this.unifiedLogTimeoutMs,
        label: "Unified log collection",
        timeoutError: () =>
          (timeoutError = new SessionLogTimeoutError(
            `Unified log collection timed out after ${this.unifiedLogTimeoutMs}ms on ${device.deviceId}.`,
          )),
        onTimeout: () => controller.abort(timeoutError),
      })
    ).stdout;
  }

  private requireSimulator(device: BootedDevice, action: string): void {
    if (resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator") {
      throw new ActionableError(
        `iOS session logs are only supported on iOS simulators; cannot ${action} on ` +
          `${device.deviceId}, which looks like a physical iOS device.`,
      );
    }
  }

  private async resolveContainerRoot(
    device: BootedDevice,
    appId: string,
    containerLabel: string,
    operation: string,
    simctlContainer: string,
  ): Promise<string> {
    this.requireSimulator(device, `${operation} ${containerLabel} logs for ${appId}`);
    const result = await executeIosAppContainerCommand(
      this.simctlFactory(device),
      `get_app_container ${shellQuote(device.deviceId)} ${shellQuote(appId)} ${shellQuote(simctlContainer)}`,
      { device, appId, container: containerLabel, operation },
    );
    const root = result.stdout.trim();
    if (!root) {
      throw new ActionableError(
        `Unable to resolve the ${containerLabel} container for ${appId} on ${device.deviceId}. ` +
          "Confirm the simulator is booted, the app is installed, and the app declares the container.",
      );
    }
    return root;
  }

  private async readBounded(
    root: string,
    path: string,
    maxBytes: number,
  ): Promise<SessionLogFileOutcome> {
    const target = join(root, normalizeAppFileRelativePath(path));
    try {
      const stat = await this.fileSystem.lstat(target);
      if (!stat.isFile()) {
        return { path, status: "failed", reason: "Not a regular file." };
      }
      const buffer = await this.fileSystem.readFileBuffer(target);
      return { path, status: "read", ...boundedContent(buffer, buffer.byteLength, maxBytes) };
    } catch (error) {
      return readOutcomeForError(path, target, error);
    }
  }

  private async resetOne(
    containerRoot: string,
    path: string,
  ): Promise<ResetAppLogsPathOutcome["status"]> {
    const target = join(containerRoot, normalizeAppFileRelativePath(path));
    const directory = dirname(target);
    const base = posix.basename(path);
    let siblings: string[] = [];
    try {
      siblings = (await this.fileSystem.readdir(directory))
        .map((entry) => entry.name)
        .filter((name) => name === base || isRotatedSibling(name, base));
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      // A missing parent directory means there is nothing to reset.
      logger.debug(`[SessionLogService] log directory missing: ${directory}: ${error}`);
    }
    if (siblings.length === 0) {
      return "missing";
    }
    for (const name of siblings) {
      await this.fileSystem.rm(join(directory, name));
    }
    return "reset";
  }
}
