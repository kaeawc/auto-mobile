import { join } from "node:path";
import { ActionableError, type BootedDevice } from "../models";
import type { HostCommandExecutor } from "../utils/HostCommandExecutor";
import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { AppFileFileSystem } from "./appFileService";
import type {
  ResetAppLogsRequest,
  SessionLogProvider,
  UnifiedLogReadBounds,
} from "./DefaultSessionLogService";
import { SessionLogSourceError } from "./SessionLogSourceError";
import { SessionLogTimeoutError } from "./SessionLogTimeoutError";
import type {
  ResetAppLogsPathOutcome,
  SessionLogFailureCode,
  SessionLogFilesResult,
  SessionLogSourceFailure,
  UnifiedLogWindowRequest,
  UnifiedLogWindowResult,
} from "./sessionLogContract";
import { logShowArgs, unifiedLogPredicate, unifiedLogWindowResult } from "./unifiedLogWindow";

/** `log collect` copies the device's log store over USB or Wi-Fi, so it gets a longer ceiling. */
export const PHYSICAL_UNIFIED_LOG_DEFAULT_TIMEOUT_MS = 60_000;
/** `log show` output is bounded to `maxBytes` afterwards; this only stops a runaway child. */
const LOG_SHOW_MAX_BUFFER = 64 * 1024 * 1024;

export interface PhysicalIosSessionLogDependencies {
  host: HostCommandExecutor;
  fileSystem: Pick<AppFileFileSystem, "mkdtemp" | "rm">;
  timer: Timer;
  /** Ceiling on `log collect` plus `log show` together. */
  timeoutMs: number;
  /** `log collect --device-udid` exists only on macOS hosts. */
  hostPlatform: NodeJS.Platform;
  /** Directory the per-collection archive directory is created in. */
  tempRoot: string;
}

interface CollectFailure {
  pattern: RegExp;
  status: Exclude<SessionLogSourceFailure["status"], "timedOut">;
  code: SessionLogFailureCode;
  hint: string;
}

/**
 * Known `log collect` failure shapes, checked in order (a locked device can also
 * read as "not found"). The wording is matched loosely because `log` prints
 * different messages across macOS releases; an unmatched failure stays a plain
 * `failed` with the full command output.
 */
const COLLECT_FAILURES: readonly CollectFailure[] = [
  {
    pattern: /must be (?:an? )?admin|must be run as root|requires root|permission denied/i,
    status: "failed",
    code: "HOST_NOT_ADMIN",
    hint: "`log collect` must run from an administrator account on the host.",
  },
  {
    pattern: /\blocked\b|passcode|unlock/i,
    status: "failed",
    code: "DEVICE_LOCKED",
    hint: "Unlock the device and retry.",
  },
  {
    pattern: /not paired|pairing|\btrust/i,
    status: "unavailable",
    code: "DEVICE_NOT_PAIRED",
    hint: "Pair the device with this Mac and tap Trust on the device, then retry.",
  },
  {
    pattern:
      /no (?:such |matching )?devices?\b|devices? not found|could not find (?:the )?device|not connected/i,
    status: "unavailable",
    code: "DEVICE_NOT_CONNECTED",
    hint: "Connect the device over USB or the local network, then retry.",
  },
];

/**
 * Unified-log window for physical iOS devices (#14104). The host's
 * `log collect --device-udid` copies the last `lastSeconds` of the device's log
 * store into a temporary `.logarchive`, and `log show` filters it with the same
 * predicate, level flags and byte bound as the Simulator path. The archive is
 * deleted after every collection.
 *
 * App-container files and App Group containers are not reachable on a physical
 * device through this path, so those sources report `unavailable`.
 */
export class PhysicalIosSessionLogProvider implements SessionLogProvider {
  readonly platform = "ios" as const;

  constructor(private readonly deps: PhysicalIosSessionLogDependencies) {}

  async readAppLogs(device: BootedDevice): Promise<SessionLogFilesResult> {
    throw this.simulatorOnly(device, "read app-container logs");
  }

  async resetAppLogs(request: ResetAppLogsRequest): Promise<ResetAppLogsPathOutcome[]> {
    throw this.simulatorOnly(request.device, "reset app-container logs");
  }

  async collectUnifiedLog(
    device: BootedDevice,
    appId: string,
    request: UnifiedLogWindowRequest,
    { maxBytes, signal }: UnifiedLogReadBounds,
  ): Promise<UnifiedLogWindowResult> {
    if (this.deps.hostPlatform !== "darwin") {
      throw new SessionLogSourceError(
        `The unified log for physical iOS device ${device.deviceId} is not available: ` +
          "`log collect --device-udid` requires a macOS host.",
        "unavailable",
        "HOST_UNSUPPORTED",
      );
    }
    const predicate = unifiedLogPredicate(appId);
    const startedAt = this.deps.timer.now();
    const workDir = await this.deps.fileSystem.mkdtemp(
      join(this.deps.tempRoot, "automobile-ios-log-"),
    );
    try {
      const archive = join(workDir, "window.logarchive");
      const stdout = await this.runBounded(
        device,
        (childSignal) => this.collectAndShow(device, request, predicate, archive, childSignal),
        signal,
      );
      return unifiedLogWindowResult(request, stdout, maxBytes, {
        predicate,
        mechanism: "log-collect",
        collectionMs: this.deps.timer.now() - startedAt,
        timeoutMs: this.deps.timeoutMs,
      });
    } finally {
      await this.removeWorkDir(workDir);
    }
  }

  private async collectAndShow(
    device: BootedDevice,
    request: UnifiedLogWindowRequest,
    predicate: string,
    archive: string,
    signal: AbortSignal,
  ): Promise<string> {
    const options = { timeoutMs: this.deps.timeoutMs, signal };
    try {
      await this.deps.host.executeCommand(
        "log",
        [
          "collect",
          "--device-udid",
          device.deviceId,
          "--last",
          `${request.lastSeconds}`,
          "--output",
          archive,
        ],
        options,
      );
    } catch (error) {
      throw classifyCollectFailure(device, error);
    }
    const shown = await this.deps.host.executeCommand(
      "log",
      [...logShowArgs(request, predicate), archive],
      { ...options, maxBuffer: LOG_SHOW_MAX_BUFFER },
    );
    return shown.stdout;
  }

  /**
   * Bound the whole collection on the injected timer, aborting the running
   * `log` child on expiry so a slow device transfer never pins the read.
   */
  private async runBounded(
    device: BootedDevice,
    run: (signal: AbortSignal) => Promise<string>,
    callerSignal?: AbortSignal,
  ): Promise<string> {
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const { timeoutMs } = this.deps;
    let timeoutError: SessionLogTimeoutError | undefined;
    return raceWithDeadline(() => run(signal), {
      timer: this.deps.timer,
      timeoutMs,
      label: "Physical iOS unified log collection",
      timeoutError: () =>
        (timeoutError = new SessionLogTimeoutError(
          `Unified log collection timed out after ${timeoutMs}ms on ${device.deviceId}. ` +
            "`log collect` copies the device log store; retry with a shorter lastSeconds.",
        )),
      onTimeout: () => controller.abort(timeoutError),
    });
  }

  private async removeWorkDir(workDir: string): Promise<void> {
    try {
      await this.deps.fileSystem.rm(workDir);
    } catch (error) {
      logger.warn(
        `[SessionLogService] failed to remove unified-log archive ${workDir}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private simulatorOnly(device: BootedDevice, action: string): ActionableError {
    return new ActionableError(
      `iOS app-container session logs are only supported on iOS simulators; cannot ${action} ` +
        `on physical iOS device ${device.deviceId}.`,
    );
  }
}

function classifyCollectFailure(device: BootedDevice, error: unknown): Error {
  const message = errorMessage(error);
  const known = COLLECT_FAILURES.find((failure) => failure.pattern.test(message));
  if (!known) {
    return new ActionableError(
      `log collect failed for physical iOS device ${device.deviceId}: ${message}`,
      { cause: error },
    );
  }
  return new SessionLogSourceError(
    `log collect failed for physical iOS device ${device.deviceId} (${known.code}). ` +
      `${known.hint}\n${message}`,
    known.status,
    known.code,
  );
}
