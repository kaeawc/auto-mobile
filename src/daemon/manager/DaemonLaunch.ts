import type { DaemonManagerSeams } from "../managerTestInternals";
import { type ExtractionCleaner } from "../extractionCleaner";
import { errorMessage } from "../../utils/describeUnknownError";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { devNull } from "node:os";
import { isStructuredLoggingEnabled, logger, resolveAutomobileLogSink } from "../../utils/logger";
import {
  INCOMPLETE_EXTRACTION_CODE,
  INCOMPLETE_EXTRACTION_EXIT_CODE,
} from "../../db/migrationDependencyIntegrity";
import { resolveAutoMobileLogsDir } from "../../utils/tempDir";
import { outputReductionFlagsToArgs } from "../../utils/outputReductionFlags";
import { EVENT_ALL_MARKERS_FLAG } from "../../utils/eventAllMarkers";
import { ActionableError } from "../../models";
import {
  DAEMON_LAUNCH_NONCE_ENV,
  PID_FILE_PATH,
  SOCKET_PATH,
  LOCK_FILE_PATH,
} from "../wire/constants";
import { DaemonStatus, DaemonOptions } from "../types";
import {
  DAEMON_LAUNCH_CWD_ENV,
  resolveDaemonLaunchWorkingDirectory,
} from "../../utils/workingDirectory";
import { TOOL_OUTPUTS_DIR_ENV } from "../../utils/toolOutputArtifacts";
import {
  DaemonLauncher,
  type DaemonLaunchCommand,
  type DaemonLaunchedProcess,
} from "../DaemonLauncher";
import { RUNNER_READINESS_TIMEOUT_FLAG } from "../../utils/runnerReadinessConfig";
import { daemonProcessEnvironment } from "../daemonOptionScopes";
import { DAEMON_SOCKET_PATH_FLAG } from "../processTable";
import { ENV } from "../../config/env";

/** Only the replaceable manager seams used by DaemonLaunch. */
export interface DaemonLaunchHost {
  remainingTime(deadline: number): number;
  throwIfRecoveryCancelled(signal: AbortSignal | undefined): void;
  readonly launcher: DaemonLauncher;
  readonly seams: DaemonManagerSeams;
  waitForReady(
    timeout: number,
    signal?: AbortSignal,
    shouldContinueWaiting?: () => boolean,
    maxProbeDurationMs?: number,
    launchedProcess?: { pid: number | undefined; launchNonce?: string },
  ): Promise<boolean>;
  isLaunchedProcessReady(
    pid: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
    launchNonce?: string,
  ): Promise<boolean>;
  createDaemonExitFailure(
    code: number | null,
    signal: NodeJS.Signals | null,
    logPath: string,
  ): Promise<Error>;
  withDaemonOptions(launch: DaemonLaunchCommand, options: DaemonOptions): DaemonLaunchCommand;
  readonly fallbackLauncher: DaemonLauncher;
  readonly extractionCleaner: ExtractionCleaner;
  describeError(error: unknown): string;
  readonly recoveryOwner?: DaemonStatus;
  readonly pidFilePath: string;
  readonly lockFilePath: string;
  readonly socketPath: string;
  readonly launchCommandResolver: (() => DaemonLaunchCommand) | undefined;
  getLockHolderStartupLogPath(): Promise<string | null>;
}

/** Daemon Launch lifecycle operations. */
export class DaemonLaunch {
  constructor(private readonly host: DaemonLaunchHost) {}
  /**
   * Run the launcher, retrying once after removing an incomplete package extraction. The
   * launch command is re-resolved through the fallback launcher after a successful cleanup.
   */
  async launchWithExtractionRetry(
    launch: {
      options: DaemonOptions;
      childEnv: NodeJS.ProcessEnv;
      logSink: ReturnType<typeof resolveAutomobileLogSink>;
      capturesLaunchOutput: boolean;
      logFd: number;
      logPath: string;
    },
    initial: DaemonLaunchCommand,
    startDeadline: number,
    recoverySignal: AbortSignal | undefined,
  ): Promise<void> {
    const { options, childEnv, logSink, capturesLaunchOutput, logFd, logPath } = launch;
    let { command: autoMobileCmd, args, packageRunner } = initial;
    let retriedIncompleteExtraction = false;
    while (true) {
      const attemptBudget = this.host.remainingTime(startDeadline);
      if (attemptBudget <= 0) {
        throw new ActionableError(
          "Daemon startup deadline elapsed before launch; refusing to start a daemon after the client deadline.",
        );
      }
      try {
        this.host.throwIfRecoveryCancelled(recoverySignal);
        let launchedPid: number | undefined;
        const launchNonce = packageRunner ? this.host.seams.nextLaunchNonce() : undefined;
        await this.host.launcher.launchAndWait({
          command: autoMobileCmd,
          args,
          spawnOptions: {
            detached: true,
            cwd: this.host.seams.launchWorkingDirectory(),
            stdio: [
              "ignore",
              capturesLaunchOutput ? logFd : "ignore",
              logSink === "stderr" || logSink === "both" ? "pipe" : logFd,
            ],
            env: { ...childEnv, [DAEMON_LAUNCH_NONCE_ENV]: launchNonce },
          },
          onSpawn: (child) => {
            launchedPid = child.pid;
            if (logSink === "stderr" || logSink === "both") {
              relayDaemonStderr(child);
            }
          },
          timeoutMs: attemptBudget,
          waitForReady: (timeoutMs, signal) =>
            this.host.waitForReady(timeoutMs, signal, undefined, undefined, {
              pid: launchedPid,
              launchNonce,
            }),
          isReadyForLaunchedProcess: (pid, timeoutMs, signal) =>
            this.host.isLaunchedProcessReady(pid, timeoutMs, signal, launchNonce),
          formatFailure: (summary) => this.createDaemonStartupFailure(summary, logPath),
          formatExitFailure: (code, signal) =>
            this.host.createDaemonExitFailure(code, signal, logPath),
        });
        break;
      } catch (error) {
        if (!this.isIncompleteExtractionStartupError(error) || retriedIncompleteExtraction) {
          throw error;
        }

        retriedIncompleteExtraction = true;
        const removed = await this.removeIncompleteExtraction(args[0], error, recoverySignal);
        if (!removed) {
          throw error;
        }
        ({
          command: autoMobileCmd,
          args,
          packageRunner,
        } = this.host.withDaemonOptions(this.host.fallbackLauncher.resolveCommand(), options));
        stderrLog(
          `Detected incomplete daemon package extraction (${INCOMPLETE_EXTRACTION_CODE}); removed it and retrying once...`,
        );
      }
    }
  }

  /** Remove the incomplete package extraction behind a failed launch; true when one was removed. */
  private async removeIncompleteExtraction(
    entryScript: string | undefined,
    launchError: unknown,
    recoverySignal: AbortSignal | undefined,
  ): Promise<boolean> {
    try {
      const removed = entryScript
        ? await this.host.extractionCleaner.removeExtractionForEntryScript(entryScript)
        : false;
      this.host.throwIfRecoveryCancelled(recoverySignal);
      return removed;
    } catch (cleanupError) {
      throw new ActionableError(
        `${this.host.describeError(launchError)}\nFailed to remove incomplete extraction before retry: ${this.host.describeError(cleanupError)}`,
      );
    }
  }

  daemonLaunchEnvironment(options: DaemonOptions): NodeJS.ProcessEnv {
    const childEnv = daemonProcessEnvironment(process.env);
    if (this.host.recoveryOwner?.dbPath) {
      childEnv.AUTOMOBILE_DB_PATH = this.host.recoveryOwner.dbPath;
    }
    childEnv[DAEMON_LAUNCH_CWD_ENV] = resolveDaemonLaunchWorkingDirectory();
    if (this.host.pidFilePath !== PID_FILE_PATH) {
      childEnv[ENV.DAEMON_PID_FILE_PATH.name] = this.host.pidFilePath;
    }
    if (this.host.lockFilePath !== LOCK_FILE_PATH) {
      childEnv[ENV.DAEMON_LOCK_FILE_PATH.name] = this.host.lockFilePath;
    }
    if (this.host.socketPath !== SOCKET_PATH) {
      childEnv[ENV.DAEMON_SOCKET_PATH.name] = this.host.socketPath;
    }
    if (options.toolOutputsDir) {
      childEnv[TOOL_OUTPUTS_DIR_ENV] = options.toolOutputsDir;
    }
    return childEnv;
  }

  /** Merge the launch options into the daemon command. Public so tests can observe the launch options. */
  withDaemonOptions(launch: DaemonLaunchCommand, options: DaemonOptions): DaemonLaunchCommand {
    const args = [
      ...launch.args,
      `${DAEMON_SOCKET_PATH_FLAG}=${encodeURIComponent(this.host.socketPath)}`,
    ];
    appendDaemonConnectionArgs(args, options);
    appendDaemonVideoArgs(args, options);
    appendDaemonToolArgs(args, options);
    appendDaemonViewArgs(args, options);
    appendDaemonFeatureArgs(args, options);
    // Shared specs keep output-reduction launch flags aligned with parseDaemonArgs (#2756).
    args.push(...outputReductionFlagsToArgs(options));
    return { ...launch, args };
  }

  resolveLaunchCommand(): DaemonLaunchCommand {
    return this.host.launchCommandResolver?.() ?? this.host.launcher.resolveCommand();
  }

  private async createDaemonStartupFailure(summary: string, logPath: string): Promise<Error> {
    const error = new ActionableError(await this.formatDaemonStartupFailure(summary, logPath));
    if (this.isIncompleteExtractionStartupSummary(summary)) {
      (error as { code?: string }).code = INCOMPLETE_EXTRACTION_CODE;
    }
    return error;
  }

  async createLockHolderStartupFailure(retainedLogPath?: string | null): Promise<Error> {
    const summary = "Another process is starting the daemon but it failed to become ready";
    const logPath = retainedLogPath ?? (await this.host.getLockHolderStartupLogPath());
    if (!logPath) {
      return new ActionableError(
        `${summary}; the startup lock did not contain a usable holder PID for diagnostics.`,
      );
    }
    return new ActionableError(await this.formatDaemonStartupFailure(summary, logPath));
  }

  daemonLaunchLogPath(): string {
    return join(resolveAutoMobileLogsDir(), `daemon-launch-${process.pid}.log`);
  }

  async createDaemonExitFailure(
    code: number | null,
    signal: NodeJS.Signals | null,
    logPath: string,
  ): Promise<Error> {
    const exitCode = code === null ? "unknown" : code.toString();
    const signalDetail = signal ? `, signal ${signal}` : "";
    const summary =
      code === INCOMPLETE_EXTRACTION_EXIT_CODE
        ? this.formatIncompleteExtractionStartupSummary(exitCode, signalDetail)
        : `Daemon subprocess exited before becoming ready (exit code ${exitCode}${signalDetail})`;
    return this.createDaemonStartupFailure(summary, logPath);
  }

  private formatIncompleteExtractionStartupSummary(exitCode: string, signalDetail: string): string {
    return (
      `Daemon subprocess exited before becoming ready (exit code ${exitCode}${signalDetail}): ` +
      `database startup migrations reported an incomplete package extraction (${INCOMPLETE_EXTRACTION_CODE}). ` +
      "remove the incomplete extraction directory and re-run; a fresh extraction from the healthy shared cache should start normally."
    );
  }

  private isIncompleteExtractionStartupSummary(summary: string): boolean {
    return (
      summary.includes(`exit code ${INCOMPLETE_EXTRACTION_EXIT_CODE}`) &&
      summary.includes("incomplete package extraction")
    );
  }

  private isIncompleteExtractionStartupError(error: unknown): boolean {
    return (error as { code?: unknown } | null | undefined)?.code === INCOMPLETE_EXTRACTION_CODE;
  }

  describeError(error: unknown): string {
    return errorMessage(error);
  }

  private async formatDaemonStartupFailure(summary: string, logPath: string): Promise<string> {
    const logExcerpt = await this.readDaemonStartupLogExcerpt(logPath);
    if (logExcerpt.length === 0) {
      if (logPath === devNull) {
        return `${summary}\nDaemon stderr was relayed to the configured process sink; file capture is disabled.`;
      }
      return `${summary}\nLogs: ${logPath} (empty)`;
    }
    return [
      summary,
      `Logs: ${logPath}`,
      `${this.daemonLaunchLogLabel()} (last ${MAX_DAEMON_STARTUP_LOG_BYTES} bytes):`,
      logExcerpt,
    ].join("\n");
  }

  private daemonLaunchLogLabel(): string {
    return resolveAutomobileLogSink() === "file"
      ? "Daemon stdout/stderr log excerpt"
      : "Daemon stdout log excerpt; stderr was relayed to the configured process sink";
  }

  private async readDaemonStartupLogExcerpt(logPath: string): Promise<string> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(logPath, "r");
      const { size } = await file.stat();
      const start = Math.max(0, size - MAX_DAEMON_STARTUP_LOG_BYTES);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      const log = buffer.subarray(0, bytesRead).toString("utf-8").trim();
      return start > 0 ? `...${log}` : log;
    } catch (error) {
      return `Unable to read daemon stdout/stderr log: ${errorMessage(error)}`;
    } finally {
      await file?.close();
    }
  }
}

/**
 * Write a message to stderr so it never corrupts the MCP stdio channel.
 * When the MCP server runs in proxy mode, stdout carries JSON-RPC traffic.
 * All daemon lifecycle messages must go to stderr (or the file logger).
 */
export function stderrLog(message: string): void {
  if (isStructuredLoggingEnabled()) {
    logger.info(message);
    return;
  }
  process.stderr.write(message + "\n");
}

/**
 * Relays a detached daemon's stderr without passing the parent's descriptor to
 * the child. The unref'd read end lets a terminating stdio host close its own
 * stderr pipe promptly; while the host is alive, pause/resume honors sink
 * backpressure instead of accumulating arbitrary buffered output.
 */
export function relayDaemonStderr(daemonProcess: Pick<DaemonLaunchedProcess, "stderr">): void {
  const daemonStderr = daemonProcess.stderr;
  if (!daemonStderr) {
    return;
  }
  daemonStderr.on("data", (chunk: Buffer) => {
    if (!process.stderr.write(chunk)) {
      daemonStderr.pause();
      process.stderr.once("drain", () => daemonStderr.resume());
    }
  });
  (daemonStderr as typeof daemonStderr & { unref?: () => void }).unref?.();
}

const MAX_DAEMON_STARTUP_LOG_BYTES = 4000;

function appendDaemonConnectionArgs(args: string[], options: DaemonOptions): void {
  if (options.port) {
    args.push("--port", options.port.toString());
  }
  if (options.host) {
    args.push("--host", options.host);
  }
  appendDaemonSwitchArgs(args, [
    [options.strictPort, "--strict-port"],
    [options.debug, "--debug"],
    [options.debugPerf, "--debug-perf"],
  ]);
  if (options.planExecutionLockScope) {
    args.push("--plan-execution-lock-scope", options.planExecutionLockScope);
  }
  if (options.runnerReadinessTimeoutMs !== undefined) {
    args.push(RUNNER_READINESS_TIMEOUT_FLAG, options.runnerReadinessTimeoutMs.toString());
  }
}

function appendDaemonVideoArgs(args: string[], options: DaemonOptions): void {
  if (options.videoQualityPreset) {
    args.push("--video-quality", options.videoQualityPreset);
  }
  if (options.videoTargetBitrateKbps !== undefined) {
    args.push("--video-target-bitrate-kbps", options.videoTargetBitrateKbps.toString());
  }
  if (options.videoMaxThroughputMbps !== undefined) {
    args.push("--video-max-throughput-mbps", options.videoMaxThroughputMbps.toString());
  }
  if (options.videoFps !== undefined) {
    args.push("--video-fps", options.videoFps.toString());
  }
  if (options.videoFormat) {
    args.push("--video-format", options.videoFormat);
  }
  if (options.videoMaxArchiveSizeMb !== undefined) {
    args.push("--video-archive-size-mb", options.videoMaxArchiveSizeMb.toString());
  }
}

function appendDaemonToolArgs(args: string[], options: DaemonOptions): void {
  appendDaemonSwitchArgs(args, [
    [options.networkMockable, "--network-mockable"],
    [options.embeddedSdk, "--embedded-sdk"],
  ]);
  for (const toolName of options.enabledTools ?? []) {
    args.push("--enable-tool", toolName);
  }
  for (const toolName of options.disabledTools ?? []) {
    args.push("--disable-tool", toolName);
  }
  if (options.dismissKeyboardAfterInput) {
    args.push("--dismiss-keyboard-after-input");
  }
  if (options.eventAllMarkers && options.eventAllMarkers.length > 0) {
    args.push(EVENT_ALL_MARKERS_FLAG, options.eventAllMarkers.join(","));
  } else if (options.eventAllMarkersCliOverride) {
    args.push(`${EVENT_ALL_MARKERS_FLAG}=`);
  }
}

function appendDaemonViewArgs(args: string[], options: DaemonOptions): void {
  appendDaemonSwitchArgs(args, [
    [options.noUiPerfMode, "--no-ui-perf-mode"],
    [options.noNavigationScreenshots, "--no-navigation-screenshots"],
    [options.noWaitForPollingOverhead, "--no-waitfor-polling-overhead"],
    [options.noOcclusion, "--no-occlusion"],
    [options.noA11yIncludeNotImportantViews, "--no-include-not-important-views"],
    [options.noA11yReportViewIds, "--no-report-view-ids"],
    [options.noA11yRetrieveInteractiveWindows, "--no-retrieve-interactive-windows"],
  ]);
}

function appendDaemonFeatureArgs(args: string[], options: DaemonOptions): void {
  appendDaemonSwitchArgs(args, [
    [options.memPerfAudit, "--mem-perf-audit"],
    [options.accessibilityAudit, "--accessibility-audit"],
  ]);
  if (options.accessibilityLevel) {
    args.push("--a11y-level", options.accessibilityLevel);
  }
  if (options.accessibilityFailureMode) {
    args.push("--a11y-failure-mode", options.accessibilityFailureMode);
  }
  if (options.accessibilityMinSeverity) {
    args.push("--a11y-min-severity", options.accessibilityMinSeverity);
  }
  appendDaemonSwitchArgs(args, [
    [options.accessibilityUseBaseline, "--a11y-use-baseline"],
    [options.predictiveUi, "--predictive-ui"],
    [options.rawElementSearch, "--raw-element-search"],
    [options.skipCtrlProxyDownload, "--skip-ctrl-proxy-download"],
    [options.toolCallRecording, "--tool-call-recording"],
  ]);
}

function appendDaemonSwitchArgs(
  args: string[],
  flags: ReadonlyArray<readonly [boolean | undefined, string]>,
): void {
  for (const [enabled, flag] of flags) {
    if (enabled) {
      args.push(flag);
    }
  }
}
