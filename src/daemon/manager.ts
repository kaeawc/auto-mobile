import { execSync } from "node:child_process";
import { open, readFile, rm, unlink } from "node:fs/promises";
import { existsSync, openSync, closeSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "../utils/logger";
import { resolveDaemonInstallSpecifier } from "../constants/release";
import {
  INCOMPLETE_EXTRACTION_CODE,
  INCOMPLETE_EXTRACTION_EXIT_CODE,
} from "../db/migrationDependencyIntegrity";
import { ensureSecureLogsDirSync } from "../utils/tempDir";
import { outputReductionFlagsToArgs } from "../utils/outputReductionFlags";
import {
  EVENT_ALL_MARKERS_FLAG,
  hasEventAllMarkersCliOverride,
  parseEventAllMarkersConfig,
} from "../utils/eventAllMarkers";
import { shouldSkipCtrlProxyDownload } from "../utils/ctrlProxyDownloadControl";
import { ActionableError } from "../models";
import {
  PID_FILE_PATH,
  SOCKET_PATH,
  LOCK_FILE_PATH,
  DAEMON_STARTUP_TIMEOUT_MS,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  READINESS_PROBE_MAX_ATTEMPTS,
  READINESS_PROBE_BACKOFF_MS,
} from "./constants";
import { DaemonStatus, PidFileData, DaemonOptions } from "./types";
import {
  getDaemonHealthReport,
  formatHealthReport,
  runSocketDiagnostics,
  formatSocketDiagnostics,
} from "./debugTools";
import { DaemonClient, type DaemonClientFactory, type DaemonClientLike } from "./client";
import {
  buildIdentitiesMatch,
  buildIdentityFromStatus,
  describeBuildIdentity,
  getCurrentBuildIdentity,
  type BuildIdentity,
} from "./buildIdentity";
import { DaemonState, type DaemonStateLike } from "./daemonState";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import {
  cleanupDaemonFiles,
  isProcessRunning as isDaemonProcessRunning,
} from "./daemonFiles";
import { releaseExclusiveLock, tryAcquireExclusiveLock } from "../utils/fileLock";
import {
  DAEMON_LAUNCH_CWD_ENV,
  resolveDaemonLaunchWorkingDirectory,
  resolvePathFromDaemonLaunchWorkingDirectory,
  resolveStableDaemonWorkingDirectory,
} from "../utils/workingDirectory";
import {
  parseToolOutputsDirConfig,
  TOOL_OUTPUTS_DIR_FLAG,
  TOOL_OUTPUT_DIR_FLAG_ALIAS,
  TOOL_OUTPUTS_DIR_ENV,
} from "../utils/toolOutputArtifacts";
import {
  DaemonLauncher,
  type DaemonLaunchCommand,
  type DaemonProcessSpawner,
} from "./DaemonLauncher";
import {
  RUNNER_READINESS_TIMEOUT_ENV,
  RUNNER_READINESS_TIMEOUT_FLAG,
  parseRunnerReadinessTimeout,
} from "../utils/runnerReadinessConfig";

export type { DaemonLaunchCommand, DaemonProcessSpawner } from "./DaemonLauncher";

/**
 * Write a message to stderr so it never corrupts the MCP stdio channel.
 * When the MCP server runs in proxy mode, stdout carries JSON-RPC traffic.
 * All daemon lifecycle messages must go to stderr (or the file logger).
 */
function stderrLog(message: string): void {
  process.stderr.write(message + "\n");
}

export interface DaemonProcessRecord {
  pid: number;
  ppid: number;
  command: string;
}

export interface DaemonProcessFinder {
  findDaemonProcesses(): DaemonProcessRecord[];
}

export const DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

type ProcessTableCommandRunner = (
  command: string,
  options: { encoding: "utf-8"; maxBuffer: number }
) => string;

function normalizeProcessCommand(command: string): string {
  return command.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isAutoMobileDaemonCommand(command: string): boolean {
  const normalizedCommand = normalizeProcessCommand(command);
  return normalizedCommand.includes("--daemon-mode") &&
    (normalizedCommand.includes("auto-mobile") || normalizedCommand.includes("dist/src/index.js"));
}

function isShellCommandWrapper(command: string): boolean {
  const normalizedCommand = normalizeProcessCommand(command);
  const trimmedCommand = normalizedCommand.trim();
  const executable = trimmedCommand.startsWith("\"")
    ? trimmedCommand.slice(1, trimmedCommand.indexOf("\"", 1))
    : trimmedCommand.split(/\s+/, 1)[0] ?? "";

  if (/(^|\/)(?:ba|da|z)?sh$/.test(executable) && normalizedCommand.includes(" -c ")) {
    return true;
  }

  if (/(^|\/)cmd(?:\.exe)?$/i.test(executable) && /(?:^|\s)\/c(?:\s|$)/i.test(normalizedCommand)) {
    return true;
  }

  return /(^|\/)(?:powershell|pwsh)(?:\.exe)?$/i.test(executable) &&
    /(?:^|\s)-(?:command|encodedcommand|c|ec)(?:\s|$)/i.test(normalizedCommand);
}

export function parseDaemonProcessTable(psOutput: string): DaemonProcessRecord[] {
  const records: DaemonProcessRecord[] = [];

  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }

    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const command = match[3];

    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !isAutoMobileDaemonCommand(command)) {
      continue;
    }

    records.push({ pid, ppid, command });
  }

  return records;
}

interface WindowsProcessTableEntry {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  CommandLine?: unknown;
}

function parseWindowsProcessId(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseWindowsProcessTableEntry(entry: WindowsProcessTableEntry): DaemonProcessRecord | undefined {
  const pid = parseWindowsProcessId(entry.ProcessId);
  const ppid = parseWindowsProcessId(entry.ParentProcessId);
  const command = entry.CommandLine;

  if (
    pid === undefined ||
    ppid === undefined ||
    typeof command !== "string" ||
    !isAutoMobileDaemonCommand(command)
  ) {
    return undefined;
  }

  return { pid, ppid, command };
}

export function parseWindowsDaemonProcessTable(processTableJson: string): DaemonProcessRecord[] {
  const parsed: unknown = JSON.parse(processTableJson);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const records: DaemonProcessRecord[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = parseWindowsProcessTableEntry(entry);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

export interface DaemonProcessLivenessChecker {
  isProcessRunning(pid: number): boolean;
}

export interface DaemonProcessSignaler {
  signal(pid: number, signal: NodeJS.Signals): void;
}

const defaultDaemonProcessSignaler: DaemonProcessSignaler = {
  signal(pid, signal): void {
    process.kill(pid, signal);
  },
};

export class PsDaemonProcessFinder implements DaemonProcessFinder, DaemonProcessLivenessChecker {
  constructor(private readonly runCommand: ProcessTableCommandRunner = execSync) {}

  findDaemonProcesses(): DaemonProcessRecord[] {
    const psOutput = this.runCommand("ps -eo pid=,ppid=,command=", {
      encoding: "utf-8",
      maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
    });
    return parseDaemonProcessTable(psOutput);
  }

  isProcessRunning(pid: number): boolean {
    return isDaemonProcessRunning(pid);
  }
}

export class WindowsDaemonProcessFinder implements DaemonProcessFinder, DaemonProcessLivenessChecker {
  constructor(private readonly runCommand: ProcessTableCommandRunner = execSync) {}

  findDaemonProcesses(): DaemonProcessRecord[] {
    const processTableJson = this.runCommand(
      "powershell.exe -NoProfile -NonInteractive -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress\"",
      {
        encoding: "utf-8",
        maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
      }
    );
    return parseWindowsDaemonProcessTable(processTableJson);
  }

  isProcessRunning(pid: number): boolean {
    return isDaemonProcessRunning(pid);
  }
}

export function createDefaultDaemonProcessFinder(
  platform: NodeJS.Platform = process.platform
): DaemonProcessFinder & DaemonProcessLivenessChecker {
  return platform === "win32" ? new WindowsDaemonProcessFinder() : new PsDaemonProcessFinder();
}

export interface ExtractionCleaner {
  removeExtractionForEntryScript(entryScript: string): Promise<boolean>;
}

function resolveExtractionRootForEntryScript(entryScript: string): string | null {
  const resolved = resolve(entryScript);
  const parts = resolved.split(sep);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex <= 0) {
    return null;
  }

  const packagePath = parts.slice(nodeModulesIndex + 1, nodeModulesIndex + 3).join("/");
  if (packagePath !== "@kaeawc/auto-mobile") {
    return null;
  }

  const root = parts.slice(0, nodeModulesIndex).join(sep) || sep;
  if (root === sep) {
    return null;
  }

  const tempRoot = resolve(tmpdir());
  if (!root.startsWith(tempRoot + sep)) {
    return null;
  }
  return root;
}

const fileSystemExtractionCleaner: ExtractionCleaner = {
  async removeExtractionForEntryScript(entryScript: string): Promise<boolean> {
    const extractionRoot = resolveExtractionRootForEntryScript(entryScript);
    if (!extractionRoot) {
      return false;
    }

    await rm(extractionRoot, { recursive: true, force: true });
    return true;
  },
};

function hasProcessLivenessChecker(value: unknown): value is DaemonProcessLivenessChecker {
  return typeof (value as Partial<DaemonProcessLivenessChecker> | undefined)?.isProcessRunning === "function";
}

const MAX_DAEMON_STARTUP_LOG_BYTES = 4000;

/**
 * Surface of DaemonManager used by clients (e.g. DaemonMcpProxy).
 * Allows injecting fakes in tests without subclassing the concrete class.
 */
export interface DaemonManagerLike {
  status(): Promise<DaemonStatus>;
  start(options?: DaemonOptions): Promise<void>;
  restart(options?: DaemonOptions): Promise<void>;
  waitForReady(timeout: number, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Daemon Manager
 *
 * Handles daemon lifecycle:
 * - Start daemon in background
 * - Stop daemon gracefully
 * - Check daemon status
 * - Restart daemon
 */
export class DaemonManager implements DaemonManagerLike {
  private readonly clientFactory: DaemonClientFactory;
  private readonly stateProvider: () => DaemonStateLike;
  private readonly timer: Timer;
  private readonly lockFilePath: string;
  private readonly pidFilePath: string;
  private readonly socketPath: string;
  private readonly processFinder: DaemonProcessFinder;
  private readonly processLivenessChecker: DaemonProcessLivenessChecker;
  private readonly processSignaler: DaemonProcessSignaler;
  private readonly extractionCleaner: ExtractionCleaner;
  private readonly launcher: DaemonLauncher;
  private readonly fallbackLauncher: DaemonLauncher;
  private readonly launchCommandResolver: (() => DaemonLaunchCommand) | undefined;

  constructor(
    clientFactory: DaemonClientFactory | undefined = undefined,
    stateProvider: () => DaemonStateLike = () => DaemonState.getInstance(),
    timer: Timer = defaultTimer,
    lockFilePath: string = LOCK_FILE_PATH,
    pidFilePath: string = PID_FILE_PATH,
    socketPath: string = SOCKET_PATH,
    processFinderOrSpawner: DaemonProcessFinder | DaemonProcessSpawner = createDefaultDaemonProcessFinder(),
    processSpawner: DaemonProcessSpawner | undefined = undefined,
    extractionCleaner: ExtractionCleaner = fileSystemExtractionCleaner,
    launcher: DaemonLauncher | (() => DaemonLaunchCommand) | undefined = undefined,
    processSignaler: DaemonProcessSignaler = defaultDaemonProcessSignaler,
  ) {
    this.stateProvider = stateProvider;
    this.timer = timer;
    this.lockFilePath = resolvePathFromDaemonLaunchWorkingDirectory(lockFilePath);
    this.pidFilePath = resolvePathFromDaemonLaunchWorkingDirectory(pidFilePath);
    this.socketPath = resolvePathFromDaemonLaunchWorkingDirectory(socketPath);
    if ("findDaemonProcesses" in processFinderOrSpawner) {
      this.processFinder = processFinderOrSpawner;
      this.processLivenessChecker = hasProcessLivenessChecker(processFinderOrSpawner)
        ? processFinderOrSpawner
        : createDefaultDaemonProcessFinder();
    } else {
      const processFinder = createDefaultDaemonProcessFinder();
      this.processFinder = processFinder;
      this.processLivenessChecker = processFinder;
      processSpawner = processFinderOrSpawner;
    }
    this.processSignaler = processSignaler;
    this.extractionCleaner = extractionCleaner;
    this.launchCommandResolver = typeof launcher === "function" ? launcher : undefined;
    this.launcher = (typeof launcher === "object" ? launcher : undefined) ?? new DaemonLauncher({
      spawn: processSpawner?.spawn.bind(processSpawner),
      timer,
    });
    this.fallbackLauncher = new DaemonLauncher({
      entryScript: null,
      spawn: processSpawner?.spawn.bind(processSpawner),
      timer,
    });
    this.clientFactory = clientFactory ?? (() => new DaemonClient(this.socketPath));
  }

  /**
   * Acquire an exclusive file lock for daemon start/stop coordination.
   * Uses O_CREAT | O_EXCL for atomic creation. Returns true if lock acquired.
   * Cleans up stale locks from dead processes.
   *
   * Non-blocking (single attempt): the caller decides what to do on false. Shares
   * the canonical `O_EXCL` + stale-reclaim primitive with the DB migration lock
   * (`src/utils/fileLock.ts`). `reclaimOwnPid` stays false so a same-PID probe
   * from another manager instance still reads as actively held.
   */
  acquireLock(): boolean {
    return tryAcquireExclusiveLock(this.lockFilePath, {
      isProcessRunning: pid => this.isProcessRunning(pid),
    });
  }

  /**
   * Release the file lock. Compare-and-delete: only removes the file if it still
   * holds our PID, so it can't delete a lock another opener reclaimed.
   */
  releaseLock(): void {
    releaseExclusiveLock(this.lockFilePath);
  }

  createClient(): DaemonClientLike {
    return this.clientFactory();
  }

  getDaemonState(): DaemonStateLike {
    return this.stateProvider();
  }

  private cleanupSocketPaths(primarySocketPath?: string): string[] | undefined {
    if (this.pidFilePath === PID_FILE_PATH) {
      return undefined;
    }
    return primarySocketPath ? [primarySocketPath] : [];
  }

  /**
   * Find all running auto-mobile daemon processes (including those from other worktrees)
   */
  findAllDaemonProcesses(): number[] {
    try {
      return this.normalizeDaemonProcessRecords(this.processFinder.findDaemonProcesses());
    } catch (error) {
      throw new ActionableError(
        `Failed to inspect daemon process table: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  findOtherDaemonProcesses(activeDaemonPid: number | undefined): number[] {
    return this.findLiveDaemonProcesses().filter(pid => pid !== activeDaemonPid);
  }

  findLiveDaemonProcesses(): number[] {
    return this.findAllDaemonProcesses().filter(pid => this.isProcessRunning(pid));
  }

  private normalizeDaemonProcessRecords(records: DaemonProcessRecord[]): number[] {
    const wrapperPids = new Set<number>();
    const childPpids = new Set(records.map(record => record.ppid));

    for (const record of records) {
      if (isShellCommandWrapper(record.command) && childPpids.has(record.pid)) {
        wrapperPids.add(record.pid);
      }
    }

    const pids: number[] = [];
    const seen = new Set<number>();

    for (const record of records) {
      if (record.pid === process.pid || wrapperPids.has(record.pid) || seen.has(record.pid)) {
        continue;
      }

      pids.push(record.pid);
      seen.add(record.pid);
    }

    return pids;
  }

  /**
   * Start the daemon in background (detached process).
   * Uses an atomic file lock to prevent thundering herd when multiple
   * proxy processes try to start the daemon simultaneously.
   */
  async start(options: DaemonOptions = {}): Promise<void> {
    const acquired = this.acquireLock();
    if (!acquired) {
      // Another process is starting the daemon — wait for it to become ready
      stderrLog("Another process is starting the daemon, waiting...");
      const ready = await this.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
      if (ready) {
        stderrLog("Daemon started by another process");
        return;
      }
      // Lock holder may have crashed — retry lock acquisition once
      const retryAcquired = this.acquireLock();
      if (retryAcquired) {
        stderrLog("Previous lock holder failed, taking over daemon start...");
        try {
          await this.startUnlocked(options);
        } finally {
          this.releaseLock();
        }
        return;
      }
      // Another process won the retry race — wait for it to finish
      stderrLog("Another process is retrying daemon start, waiting...");
      const retryReady = await this.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
      if (retryReady) {
        stderrLog("Daemon started by another process (retry)");
        return;
      }
      throw new ActionableError(
        "Another process is starting the daemon but it failed to become ready"
      );
    }

    try {
      await this.startUnlocked(options);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Internal start implementation (caller must hold lock).
   */
  private async startUnlocked(options: DaemonOptions): Promise<void> {
    const status = await this.status();
    if (status.running) {
      stderrLog(`Daemon is already running (PID ${status.pid}, port ${status.port})`);
      return;
    }

    // A missing or stale PID record must not turn an ordinary start request into
    // permission to terminate a live daemon. This happens when a second client
    // reaches the shared socket during a long-running tool call and races a
    // transient availability probe. Reuse a responsive daemon; require an
    // explicit restart for a live but unreachable process.
    const liveDaemons = this.findLiveDaemonProcesses();
    if (liveDaemons.length > 0) {
      stderrLog(
        `Found ${liveDaemons.length} live auto-mobile daemon process(es) without a usable PID record; waiting for one to become ready...`
      );
      for (const pid of liveDaemons) {
        stderrLog(`  - PID ${pid}`);
      }
      if (await this.waitForExistingDaemon(DAEMON_STARTUP_TIMEOUT_MS)) {
        stderrLog("Reusing existing responsive daemon");
        return;
      }

      throw new ActionableError(
        `Found live AutoMobile daemon process(es) (${liveDaemons.join(", ")}) but none became reachable within ` +
        `${DAEMON_STARTUP_TIMEOUT_MS}ms. Refusing to terminate a live daemon during start; ` +
        `inspect it or run \`bunx ${resolveDaemonInstallSpecifier()} --daemon restart\` explicitly.`
      );
    }

    // Clean up stale socket and PID files from previous sessions
    await cleanupDaemonFiles({ pidFilePath: this.pidFilePath });

    stderrLog("Starting AutoMobile daemon...");

    // Resolve the current binary so the daemon uses the same version.
    // process.argv[1] is the entry script (e.g. dist/src/index.js).
    // Falls back to bunx to avoid requiring a global install.
    let { command: autoMobileCmd, args } = this.withDaemonOptions(this.resolveLaunchCommand(), options);

    // Redirect the detached daemon's stdout/stderr into the configured logs dir
    // (`~/.auto-mobile/logs` by default) rather than an ephemeral
    // `mkdtemp(tmpdir())` directory. Under bunx the temp tree is reaped while the
    // daemon keeps this fd open, which previously left the on-disk log unlinked
    // and post-hoc debugging impossible (issue #2724). The logs dir is created
    // owner-only (0o700) by ensureSecureLogsDirSync, so a fixed, predictable
    // filename inside it is not exposed to other users.
    const logsDir = ensureSecureLogsDirSync();
    const logPath = join(logsDir, `daemon-launch-${process.pid}.log`);
    // Open with restricted permissions (0o600 = owner read/write only).
    // Truncate per launch so a single manager's bootstrap captures don't grow
    // unbounded across restarts.
    const logFd = openSync(logPath, "w", 0o600);

    // Propagate any non-default file paths to the child so its constants module
    // resolves to the same locations this manager polls.
    const childEnv = { ...process.env };
    childEnv[DAEMON_LAUNCH_CWD_ENV] = resolveDaemonLaunchWorkingDirectory();
    if (this.pidFilePath !== PID_FILE_PATH) {
      childEnv.AUTOMOBILE_DAEMON_PID_FILE_PATH = this.pidFilePath;
    }
    if (this.lockFilePath !== LOCK_FILE_PATH) {
      childEnv.AUTOMOBILE_DAEMON_LOCK_FILE_PATH = this.lockFilePath;
    }
    if (this.socketPath !== SOCKET_PATH) {
      childEnv.AUTOMOBILE_DAEMON_SOCKET_PATH = this.socketPath;
    }
    if (options.toolOutputsDir) {
      childEnv[TOOL_OUTPUTS_DIR_ENV] = options.toolOutputsDir;
    }

    try {
      let retriedIncompleteExtraction = false;
      while (true) {
        try {
          await this.launcher.launchAndWait({
            command: autoMobileCmd,
            args,
            spawnOptions: {
              detached: true,
              cwd: resolveStableDaemonWorkingDirectory(),
              stdio: ["ignore", logFd, logFd],
              env: childEnv,
            },
            timeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
            waitForReady: (timeoutMs, signal) => this.waitForReady(timeoutMs, signal),
            isReadyForLaunchedProcess: pid => this.isLaunchedProcessReady(pid),
            formatFailure: summary => this.createDaemonStartupFailure(summary, logPath),
            formatExitFailure: (code, signal) => this.createDaemonExitFailure(code, signal, logPath),
          });
          break;
        } catch (error) {
          if (!this.isIncompleteExtractionStartupError(error) || retriedIncompleteExtraction) {
            throw error;
          }

          retriedIncompleteExtraction = true;
          const entryScript = args[0];
          let removed = false;
          try {
            removed = entryScript ? await this.extractionCleaner.removeExtractionForEntryScript(entryScript) : false;
          } catch (cleanupError) {
            throw new ActionableError(
              `${this.describeError(error)}\nFailed to remove incomplete extraction before retry: ${this.describeError(cleanupError)}`
            );
          }
          if (!removed) {
            throw error;
          }
          ({ command: autoMobileCmd, args } = this.withDaemonOptions(this.fallbackLauncher.resolveCommand(), options));
          stderrLog(`Detected incomplete daemon package extraction (${INCOMPLETE_EXTRACTION_CODE}); removed it and retrying once...`);
        }
      }
    } finally {
      // Close our reference to the log file (daemon process still has it open)
      closeSync(logFd);
    }

    const newStatus = await this.status();
    stderrLog(
      `Daemon started successfully (PID ${newStatus.pid}, port ${newStatus.port})`
    );
    stderrLog(`Socket: ${newStatus.socketPath}`);
    stderrLog(`Logs: ${logPath}`);
  }

  private withDaemonOptions(launch: DaemonLaunchCommand, options: DaemonOptions): DaemonLaunchCommand {
    const args = [...launch.args];
    if (options.port) {
      args.push("--port", options.port.toString());
    }
    if (options.host) {
      args.push("--host", options.host);
    }
    if (options.debug) {
      args.push("--debug");
    }
    if (options.debugPerf) {
      args.push("--debug-perf");
    }
    if (options.planExecutionLockScope) {
      args.push("--plan-execution-lock-scope", options.planExecutionLockScope);
    }
    if (options.runnerReadinessTimeoutMs !== undefined) {
      args.push(RUNNER_READINESS_TIMEOUT_FLAG, options.runnerReadinessTimeoutMs.toString());
    }
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
    if (options.networkMockable) {
      args.push("--network-mockable");
    }
    if (options.embeddedSdk) {
      args.push("--embedded-sdk");
    }
    if (options.dismissKeyboardAfterInput) {
      args.push("--dismiss-keyboard-after-input");
    }
    if (options.eventAllMarkers && options.eventAllMarkers.length > 0) {
      args.push(EVENT_ALL_MARKERS_FLAG, options.eventAllMarkers.join(","));
    } else if (options.eventAllMarkersCliOverride) {
      args.push(`${EVENT_ALL_MARKERS_FLAG}=`);
    }
    if (options.noUiPerfMode) {
      args.push("--no-ui-perf-mode");
    }
    if (options.noNavigationScreenshots) {
      args.push("--no-navigation-screenshots");
    }
    if (options.noWaitForPollingOverhead) {
      args.push("--no-waitfor-polling-overhead");
    }
    if (options.noOcclusion) {
      args.push("--no-occlusion");
    }
    // Accessibility-service view-filter flags (issue #4344 propagation audit):
    // these were in the daemon-options object but serialized nowhere, so a
    // manager-spawned daemon never received them on either transport.
    if (options.noA11yIncludeNotImportantViews) {
      args.push("--no-include-not-important-views");
    }
    if (options.noA11yReportViewIds) {
      args.push("--no-report-view-ids");
    }
    if (options.noA11yRetrieveInteractiveWindows) {
      args.push("--no-retrieve-interactive-windows");
    }
    if (options.memPerfAudit) {
      args.push("--mem-perf-audit");
    }
    if (options.accessibilityAudit) {
      args.push("--accessibility-audit");
    }
    if (options.accessibilityLevel) {
      args.push("--accessibility-level", options.accessibilityLevel);
    }
    if (options.accessibilityFailureMode) {
      args.push("--accessibility-failure-mode", options.accessibilityFailureMode);
    }
    if (options.accessibilityMinSeverity) {
      args.push("--accessibility-min-severity", options.accessibilityMinSeverity);
    }
    if (options.accessibilityUseBaseline) {
      args.push("--accessibility-use-baseline");
    }
    if (options.predictiveUi) {
      args.push("--predictive-ui");
    }
    if (options.rawElementSearch) {
      args.push("--raw-element-search");
    }
    if (options.skipCtrlProxyDownload) {
      args.push("--skip-ctrl-proxy-download");
    }
    if (options.mcpRecording) {
      args.push("--mcp-recording");
    }
    // Output-reduction flags (issue #2756): serialized off the shared specs so
    // they can't drift from the daemon-side parse in parseDaemonArgs.
    args.push(...outputReductionFlagsToArgs(options));
    return { command: launch.command, args };
  }

  private resolveLaunchCommand(): DaemonLaunchCommand {
    return this.launchCommandResolver?.() ?? this.launcher.resolveCommand();
  }

  private async createDaemonStartupFailure(summary: string, logPath: string): Promise<Error> {
    const error = new ActionableError(await this.formatDaemonStartupFailure(summary, logPath));
    if (this.isIncompleteExtractionStartupSummary(summary)) {
      (error as { code?: string }).code = INCOMPLETE_EXTRACTION_CODE;
    }
    return error;
  }

  private async createDaemonExitFailure(
    code: number | null,
    signal: NodeJS.Signals | null,
    logPath: string,
  ): Promise<Error> {
    const exitCode = code === null ? "unknown" : code.toString();
    const signalDetail = signal ? `, signal ${signal}` : "";
    const summary = code === INCOMPLETE_EXTRACTION_EXIT_CODE
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
    return summary.includes(`exit code ${INCOMPLETE_EXTRACTION_EXIT_CODE}`) &&
      summary.includes("incomplete package extraction");
  }

  private isIncompleteExtractionStartupError(error: unknown): boolean {
    return (error as { code?: unknown } | null | undefined)?.code === INCOMPLETE_EXTRACTION_CODE;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async formatDaemonStartupFailure(summary: string, logPath: string): Promise<string> {
    const logExcerpt = await this.readDaemonStartupLogExcerpt(logPath);
    if (logExcerpt.length === 0) {
      return `${summary}\nLogs: ${logPath} (empty)`;
    }
    return [
      summary,
      `Logs: ${logPath}`,
      `Daemon stdout/stderr log excerpt (last ${MAX_DAEMON_STARTUP_LOG_BYTES} bytes):`,
      logExcerpt,
    ].join("\n");
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
      return `Unable to read daemon stdout/stderr log: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      await file?.close();
    }
  }

  /**
   * Stop the daemon gracefully
   */
  async stop(timeout: number = DAEMON_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    const status = await this.status();

    if (!status.running) {
      stderrLog("Daemon is not running");
      return;
    }

    stderrLog(`Stopping daemon (PID ${status.pid})...`);

    const pid = status.pid!;

    try {
      // Send SIGTERM for graceful shutdown
      process.kill(pid, "SIGTERM");

      // Wait for process to exit
      const stopped = await this.waitForStop(pid, timeout);

      if (!stopped) {
        stderrLog(`Daemon did not stop gracefully, sending SIGKILL...`);
        process.kill(pid, "SIGKILL");

        if (!(await this.waitForStop(pid, 1000))) {
          throw new Error(`Daemon process ${pid} did not exit after SIGKILL`);
        }
      }

      await cleanupDaemonFiles({
        pidFilePath: this.pidFilePath,
        socketPaths: this.cleanupSocketPaths(status.socketPath),
        expectedPid: pid,
      });

      stderrLog("Daemon stopped");
    } catch (error) {
      // Process doesn't exist or we don't have permission
      if (
        error instanceof Error &&
        (error.message.includes("ESRCH") || error.message.includes("EPERM"))
      ) {
        await cleanupDaemonFiles({
          pidFilePath: this.pidFilePath,
          socketPaths: this.cleanupSocketPaths(status.socketPath),
          expectedPid: pid,
        });
        stderrLog("Daemon was not running (cleaned up stale PID file)");
      } else {
        throw error;
      }
    }
  }

  /**
   * Check daemon status
   */
  async status(): Promise<DaemonStatus> {
    // Check if PID file exists
    if (!existsSync(this.pidFilePath)) {
      return { running: false };
    }

    try {
      // Read PID file
      const pidFileContent = await readFile(this.pidFilePath, "utf-8");
      const pidData: PidFileData = JSON.parse(pidFileContent);

      // Check if process is actually running
      const running = this.isProcessRunning(pidData.pid);

      if (!running) {
        await cleanupDaemonFiles({
          pidFilePath: this.pidFilePath,
          socketPaths: this.cleanupSocketPaths(pidData.socketPath),
          expectedPid: pidData.pid,
        });
        return { running: false };
      }

      return {
        running: true,
        pid: pidData.pid,
        port: pidData.port,
        socketPath: pidData.socketPath,
        sockets: pidData.sockets,
        dbPath: pidData.dbPath,
        startedAt: pidData.startedAt,
        version: pidData.version,
        assetVersion: pidData.assetVersion,
        entryScript: pidData.entryScript,
        buildId: pidData.buildId,
        options: pidData.options,
      };
    } catch (error) {
      logger.warn(`Error reading PID file: ${error instanceof Error ? error.message : String(error)}`);
      return { running: false };
    }
  }

  /**
   * Restart the daemon
   */
  async restart(options: DaemonOptions = {}): Promise<void> {
    stderrLog("Restarting daemon...");
    // A bare `--daemon restart` has no CLI options, but it is commonly used to
    // replace a stale checkout. Preserve the daemon's PID-recorded options so
    // that replacement cannot silently discard configuration such as debug,
    // output, or accessibility flags.
    const status = await this.status();
    const runningOptions = status.options ?? {};
    const requestedOptions = Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined)
    ) as DaemonOptions;
    const restartOptions: DaemonOptions = { ...runningOptions, ...requestedOptions };
    if (status.running) {
      await this.stop();
    }
    await this.stopUnrecordedDaemonsForExplicitRestart(status.pid);
    // Wait a bit before starting
    await this.timer.sleep(1000);
    await this.start(restartOptions);
  }

  /**
   * An explicit restart force-cleans live daemon-mode processes discovered from
   * other PID-file namespaces. This intentionally does not require this
   * manager's socket to be reachable: an orphaned daemon is precisely the
   * failure mode that `--daemon restart` must recover from. Ordinary `start`
   * remains non-destructive.
   */
  private async stopUnrecordedDaemonsForExplicitRestart(recordedPid?: number): Promise<void> {
    const candidates = this.findLiveDaemonProcesses().filter(pid => pid !== recordedPid);
    if (candidates.length === 0) {
      return;
    }

    stderrLog(
      `Explicit restart force-stopping ${candidates.length} live AutoMobile daemon candidate(s) without this namespace's PID record...`
    );
    for (const pid of candidates) {
      await this.stopUnrecordedDaemonProcess(pid);
    }
  }

  private async stopUnrecordedDaemonProcess(pid: number): Promise<void> {
    if (!this.findLiveDaemonProcesses().includes(pid)) {
      stderrLog(`Daemon candidate ${pid} exited before explicit restart could stop it.`);
      return;
    }

    stderrLog(`Stopping daemon without this namespace's PID record (PID ${pid})...`);
    try {
      this.processSignaler.signal(pid, "SIGTERM");
    } catch (error) {
      if (this.isMissingProcessError(error)) {
        return;
      }
      throw new ActionableError(
        `Failed to stop verified daemon process ${pid}: ${this.describeError(error)}`
      );
    }

    if (await this.waitForStop(pid, DAEMON_SHUTDOWN_TIMEOUT_MS)) {
      return;
    }

    stderrLog(`Verified daemon ${pid} did not stop gracefully, sending SIGKILL...`);
    if (!this.findLiveDaemonProcesses().includes(pid)) {
      stderrLog(`Daemon candidate ${pid} exited before explicit restart could force-stop it.`);
      return;
    }
    try {
      this.processSignaler.signal(pid, "SIGKILL");
    } catch (error) {
      if (this.isMissingProcessError(error)) {
        return;
      }
      throw new ActionableError(
        `Failed to force-stop verified daemon process ${pid}: ${this.describeError(error)}`
      );
    }

    if (!(await this.waitForStop(pid, 1000))) {
      throw new ActionableError(`Verified daemon process ${pid} did not exit after SIGKILL`);
    }
  }

  private isMissingProcessError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("ESRCH");
  }

  /**
   * Wait for daemon to be ready (socket listening)
   */
  async waitForReady(timeout: number, signal?: AbortSignal): Promise<boolean> {
    const startTime = this.timer.now();
    const pollInterval = 100; // Poll every 100ms
    let pollCount = 0;
    let socketObserved = false;

    while (this.timer.now() - startTime < timeout) {
      if (signal?.aborted) {
        return false;
      }
      pollCount++;
      if (existsSync(this.socketPath)) {
        socketObserved = true;
        // A daemon started from another checkout can own this namespace's socket
        // without writing this namespace's PID record. The socket connection is
        // authoritative readiness in that case; status() cannot prove ownership.
        if (await this.verifyDaemonConnection()) {
          stderrLog(
            `Daemon readiness probe succeeded after ${this.timer.now() - startTime}ms ` +
            `(${pollCount} polls; socket observed)`
          );
          return true;
        }
        if (signal?.aborted) {
          return false;
        }
        const status = await this.status();
        if (status.running) {
          await this.removeInvalidSocketPath();
        }
      }

      await this.sleepUnlessAborted(pollInterval, signal);
    }

    stderrLog(
      `Daemon readiness probe timed out after ${this.timer.now() - startTime}ms ` +
      `(${pollCount} polls; socket ${socketObserved ? "observed" : "not observed"})`
    );
    return false;
  }

  private async waitForExistingDaemon(timeout: number): Promise<boolean> {
    const startTime = this.timer.now();
    const pollInterval = 100;

    while (this.timer.now() - startTime < timeout) {
      if (await this.verifyDaemonConnection()) {
        return true;
      }
      await this.timer.sleep(pollInterval);
    }

    return false;
  }

  private sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return this.timer.sleep(ms);
    }
    if (signal.aborted) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      function done() {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      const onAbort = () => {
        this.timer.clearTimeout(timeout);
        done();
      };

      const timeout = this.timer.setTimeout(done, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async verifyDaemonConnection(): Promise<boolean> {
    // Retry the connect probe before declaring the socket dead. A single failed
    // probe is not authoritative — a live daemon under load can transiently
    // refuse a connection. Only a socket that fails every attempt is treated as
    // stale (which then triggers removeInvalidSocketPath). This is what keeps a
    // healthy daemon's socket from being unlinked on a flaky probe, the dominant
    // cause of "devices not found after daemon start/restart".
    for (let attempt = 1; attempt <= READINESS_PROBE_MAX_ATTEMPTS; attempt++) {
      const client = this.createClient();
      try {
        await client.connect();
        return true;
      } catch (error) {
        logger.debug(
          `Daemon socket readiness probe failed (attempt ${attempt}/${READINESS_PROBE_MAX_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        try {
          await client.close();
        } catch (error) {
          logger.debug(`Failed to close daemon readiness probe client: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (attempt < READINESS_PROBE_MAX_ATTEMPTS) {
        await this.timer.sleep(READINESS_PROBE_BACKOFF_MS);
      }
    }

    return false;
  }

  private async isLaunchedProcessReady(pid: number | undefined): Promise<boolean> {
    if (pid === undefined) {
      return false;
    }

    const status = await this.status();
    return status.running === true && status.pid === pid && await this.verifyDaemonConnection();
  }

  /**
   * Remove a daemon socket path that failed the readiness probe.
   *
   * This is only invoked after {@link verifyDaemonConnection} could not connect,
   * which is the authoritative signal that the path is unusable. A stale socket
   * inode left behind by a SIGKILL'd daemon is still an `isSocket()` inode, so we
   * must remove it regardless of file type — otherwise a reused PID makes
   * `status()` report running and the readiness loop spins until it times out.
   * This mirrors the unconditional stale-socket cleanup in {@link start}.
   */
  private async removeInvalidSocketPath(): Promise<void> {
    if (!existsSync(this.socketPath)) {
      return;
    }

    try {
      await unlink(this.socketPath);
      logger.debug(`Removed invalid daemon socket path: ${this.socketPath}`);
    } catch (error) {
      logger.debug(`Failed to remove invalid daemon socket path: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Wait for daemon process to stop
   */
  private async waitForStop(pid: number, timeout: number): Promise<boolean> {
    const startTime = this.timer.now();
    const pollInterval = 100;

    while (this.timer.now() - startTime < timeout) {
      if (!this.isProcessRunning(pid)) {
        return true;
      }
      await this.timer.sleep(pollInterval);
    }

    return !this.isProcessRunning(pid);
  }

  /**
   * Check if a process is running
   */
  private isProcessRunning(pid: number): boolean {
    return this.processLivenessChecker.isProcessRunning(pid);
  }

  /**
   * Get daemon PID from lock file
   */
  getPid(): number | null {
    if (!existsSync(this.pidFilePath)) {
      return null;
    }

    try {
      const pidFileContent = require("fs").readFileSync(
        this.pidFilePath,
        "utf-8"
      );
      const pidData: PidFileData = JSON.parse(pidFileContent);
      return pidData.pid;
    } catch (error) {
      // A stale or partially-written lock file fails JSON.parse; treating that
      // as "no pid on record" lets callers fall back to re-detecting the daemon.
      logger.debug(`src/daemon/manager.ts pidfile parse failed: ${error}`, error);
      return null;
    }
  }
}

export function parseDaemonArgs(args: string[], env: NodeJS.ProcessEnv = process.env): DaemonOptions {
  const options: DaemonOptions = shouldSkipCtrlProxyDownload(args, env)
    ? { skipCtrlProxyDownload: true }
    : {};
  options.toolOutputsDir = parseToolOutputsDirConfig(
    [],
    env,
    resolveDaemonLaunchWorkingDirectory()
  );
  const eventAllMarkers = parseEventAllMarkersConfig(args, env);
  const eventAllMarkersCliOverride = hasEventAllMarkersCliOverride(args);
  if (eventAllMarkers.length > 0 || eventAllMarkersCliOverride) {
    options.eventAllMarkers = eventAllMarkers;
    options.eventAllMarkersCliOverride = eventAllMarkersCliOverride;
  }
  const envRunnerReadinessTimeout = parseRunnerReadinessTimeout(
    env[RUNNER_READINESS_TIMEOUT_ENV] ?? env.AUTO_MOBILE_RUNNER_READINESS_TIMEOUT_MS,
  );
  if (envRunnerReadinessTimeout !== undefined) {
    options.runnerReadinessTimeoutMs = envRunnerReadinessTimeout;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      options.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host") {
      const host = args[i + 1];
      if (host && !host.startsWith("--")) {
        options.host = host;
      }
      i++;
    } else if (args[i] === "--debug") {
      options.debug = true;
    } else if (args[i] === "--debug-perf" || args[i] === "--ui-perf-debug") {
      options.debugPerf = true;
    } else if (args[i] === "--plan-execution-lock-scope") {
      const scope = args[i + 1];
      if (scope === "global" || scope === "session") {
        options.planExecutionLockScope = scope;
      }
      i++;
    } else if (args[i] === RUNNER_READINESS_TIMEOUT_FLAG) {
      const timeoutMs = parseRunnerReadinessTimeout(args[i + 1]);
      if (timeoutMs !== undefined) {
        options.runnerReadinessTimeoutMs = timeoutMs;
        i++;
      }
    } else if (args[i] === "--video-quality" || args[i] === "--video-quality-preset") {
      options.videoQualityPreset = args[i + 1];
      i++;
    } else if (args[i] === "--video-target-bitrate-kbps") {
      options.videoTargetBitrateKbps = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--video-max-throughput-mbps") {
      options.videoMaxThroughputMbps = Number(args[i + 1]);
      i++;
    } else if (args[i] === "--video-fps") {
      options.videoFps = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--video-format") {
      options.videoFormat = args[i + 1];
      i++;
    } else if (args[i] === "--video-archive-size-mb") {
      options.videoMaxArchiveSizeMb = Number(args[i + 1]);
      i++;
    } else if (args[i] === TOOL_OUTPUTS_DIR_FLAG || args[i] === TOOL_OUTPUT_DIR_FLAG_ALIAS) {
      const toolOutputsDir = args[i + 1];
      if (toolOutputsDir && !toolOutputsDir.startsWith("--")) {
        options.toolOutputsDir = toolOutputsDir;
      }
      i++;
    } else if (args[i] === "--network-mockable") {
      options.networkMockable = true;
    } else if (args[i] === "--embedded-sdk") {
      options.embeddedSdk = true;
    } else if (args[i] === "--dismiss-keyboard-after-input") {
      options.dismissKeyboardAfterInput = true;
    } else if (args[i] === "--no-ui-perf-mode") {
      options.noUiPerfMode = true;
    } else if (args[i] === "--no-navigation-screenshots") {
      options.noNavigationScreenshots = true;
    } else if (args[i] === "--no-waitfor-polling-overhead") {
      options.noWaitForPollingOverhead = true;
    } else if (args[i] === "--no-occlusion") {
      options.noOcclusion = true;
    } else if (args[i] === "--no-include-not-important-views") {
      options.noA11yIncludeNotImportantViews = true;
    } else if (args[i] === "--no-report-view-ids") {
      options.noA11yReportViewIds = true;
    } else if (args[i] === "--no-retrieve-interactive-windows") {
      options.noA11yRetrieveInteractiveWindows = true;
    } else if (args[i] === "--mem-perf-audit") {
      options.memPerfAudit = true;
    } else if (args[i] === "--accessibility-audit") {
      options.accessibilityAudit = true;
    } else if (args[i] === "--accessibility-level") {
      options.accessibilityLevel = args[i + 1];
      i++;
    } else if (args[i] === "--accessibility-failure-mode") {
      options.accessibilityFailureMode = args[i + 1];
      i++;
    } else if (args[i] === "--accessibility-min-severity") {
      options.accessibilityMinSeverity = args[i + 1];
      i++;
    } else if (args[i] === "--accessibility-use-baseline") {
      options.accessibilityUseBaseline = true;
    } else if (args[i] === "--predictive-ui" || args[i] === "--predictive") {
      options.predictiveUi = true;
    } else if (args[i] === "--raw-element-search") {
      options.rawElementSearch = true;
    } else if (args[i] === "--skip-ctrl-proxy-download" || args[i] === "--skip-accessibility-download") {
      options.skipCtrlProxyDownload = true;
    } else if (args[i] === "--mcp-recording") {
      options.mcpRecording = true;
    } else if (args[i] === "--observe-result-include-elements") {
      options.observeResultIncludeElements = true;
    } else if (args[i] === "--tool-results-no-structured-content") {
      options.toolResultsNoStructuredContent = true;
    } else if (args[i] === "--actions-diff-observe") {
      options.actionsDiffObserve = true;
    } else if (args[i] === "--actions-no-observe") {
      options.actionsNoObserve = true;
    }
  }
  return options;
}

/**
 * Run daemon management command
 */
export interface RunDaemonCommandOptions {
  clientFactory?: DaemonClientFactory;
  stateProvider?: () => DaemonStateLike;
}

/**
 * Build the `--daemon status` lines that surface the running daemon's build
 * identity (`buildId` + `entryScript`) and flag wrong-build skew against this
 * client. Pure so it is unit-testable without a live daemon. See #2736.
 *
 * @param status the running daemon's status (must be `running`)
 * @param client this client's build identity
 */
export function daemonBuildIdentityStatusLines(
  status: DaemonStatus,
  client: BuildIdentity
): string[] {
  const daemon = buildIdentityFromStatus(status);
  const lines = [
    `  Build ID: ${daemon.buildId || "unknown"}`,
    `  Entry Script: ${daemon.entryScript || "unknown"}`,
  ];

  if (!buildIdentitiesMatch(client, daemon)) {
    lines.push(
      "\n⚠️  WARNING: the running daemon is a different build than this checkout:",
      `  daemon build=${describeBuildIdentity(daemon)}`,
      `  client build=${describeBuildIdentity(client)}`,
      "\nRestart the daemon from this checkout (run `--daemon restart` with this same CLI) to align them."
    );
  }

  return lines;
}

export async function runDaemonCommand(
  command: string,
  args: string[],
  options: RunDaemonCommandOptions = {}
): Promise<void> {
  const manager = new DaemonManager(options.clientFactory, options.stateProvider);

  try {
    switch (command) {
      case "start": {
        await manager.start(parseDaemonArgs(args));
        break;
      }

      case "stop":
        await manager.stop();
        break;

      case "status": {
        const status = await manager.status();
        if (status.running) {
          console.log("Daemon is running");
          console.log(`  PID: ${status.pid}`);
          console.log(`  Port: ${status.port}`);
          console.log(`  Socket: ${status.socketPath}`);
          console.log(`  Database: ${status.dbPath || "unknown"}`);
          console.log(`  Version: ${status.version || "unknown"}`);
          console.log(
            `  Started: ${status.startedAt ? new Date(status.startedAt).toISOString() : "unknown"}`
          );
          for (const line of daemonBuildIdentityStatusLines(status, getCurrentBuildIdentity())) {
            console.log(line);
          }

          // Check for other daemon processes (exclude current daemon)
          const otherDaemons = manager.findOtherDaemonProcesses(status.pid);
          if (otherDaemons.length > 0) {
            console.log(
              `\n⚠️  WARNING: Found ${otherDaemons.length} other daemon process(es) from other worktrees:`
            );
            for (const pid of otherDaemons) {
              console.log(`  - PID ${pid}`);
            }
            console.log(
              `\nThese can cause device pool conflicts. Run 'bunx ${resolveDaemonInstallSpecifier()} --daemon restart' to stop them.`
            );
          }
        } else {
          console.log("Daemon is not running");
        }
        break;
      }

      case "restart": {
        await manager.restart(parseDaemonArgs(args));
        break;
      }

      case "health": {
        const report = await getDaemonHealthReport();
        console.log(formatHealthReport(report));

        // Exit with error code if daemon is not healthy
        if (!report.daemonRunning || !report.socketConnectable) {
          process.exit(1);
        }
        break;
      }

      case "diagnose": {
        console.log("Running daemon diagnostics...\n");

        // Run health check
        const healthReport = await getDaemonHealthReport();
        console.log(formatHealthReport(healthReport));

        // Run socket diagnostics
        const socketDiag = await runSocketDiagnostics();
        console.log(formatSocketDiagnostics(socketDiag));

        // Exit with error code if issues found
        if (healthReport.recommendations.length > 0 || socketDiag.issues.length > 0) {
          process.exit(1);
        }
        break;
      }

      case "available-devices": {
        const formatPoolStats = (
          stats?: { idle: number; assigned: number; error: number; total: number },
          recoveryPolicy?: { onLoss: boolean; maxAttempts: number },
          devices?: Array<{ deviceId: string; platform: string; recoveryEligibility?: unknown }>,
        ) => JSON.stringify({
          availableDevices: stats?.idle ?? 0,
          totalDevices: stats?.total ?? 0,
          assignedDevices: stats?.assigned ?? 0,
          errorDevices: stats?.error ?? 0,
          ...(recoveryPolicy ? { recoveryPolicy } : {}),
          ...(devices ? { devices } : {}),
        });

        // Check if running in daemon process
        const daemonState = manager.getDaemonState();
        if (daemonState.isInitialized()) {
          // Running inside daemon process
          const pool = daemonState.getDevicePool();
          console.log(formatPoolStats(
            pool.getStats(),
            pool.getRecoveryPolicy(),
            pool.getAllDevices().map(device => ({
              deviceId: device.id,
              platform: device.platform,
              recoveryEligibility: pool.getRecoveryEligibility(device.id),
            })),
          ));
        } else {
          // Running from CLI - query daemon via socket
          const client = manager.createClient();
          try {
            await client.connect();
            const result = await client.readResource("automobile:devices/booted");
            const content = result?.contents?.[0]?.text;
            if (!content) {
              console.log(formatPoolStats());
            } else {
              const data = JSON.parse(content);
              console.log(formatPoolStats(
                data?.poolStatus,
                data?.poolStatus?.recoveryPolicy,
                data?.devices?.map((device: {
                  deviceId: string;
                  platform: string;
                  recoveryEligibility?: unknown;
                }) => ({
                  deviceId: device.deviceId,
                  platform: device.platform,
                  recoveryEligibility: device.recoveryEligibility,
                })),
              ));
            }
            await client.close();
          } catch (error) {
            throw new ActionableError(
              `Failed to query available devices: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;
      }
      case "session-info": {
        if (args.length === 0) {
          throw new ActionableError("session-info requires a session ID argument");
        }
        const sessionId = args[0];

        // Check if running in daemon process
        const daemonState = manager.getDaemonState();
        if (daemonState.isInitialized()) {
          // Running inside daemon process
          const sessionManager = daemonState.getSessionManager();
          const session = sessionManager.getSession(sessionId);
          if (!session) {
            throw new ActionableError(`Session not found: ${sessionId}`);
          }
          console.log(JSON.stringify({
            sessionId: session.sessionId,
            assignedDevice: session.assignedDevice,
            createdAt: session.createdAt,
            lastUsedAt: session.lastUsedAt,
            expiresAt: session.expiresAt,
            cacheSize: JSON.stringify(session.cacheData).length,
          }));
        } else {
          // Running from CLI - query daemon via socket
          const client = manager.createClient();
          try {
            await client.connect();
            const result = await client.callDaemonMethod("daemon/sessionInfo", { sessionId });
            console.log(JSON.stringify(result));
            await client.close();
          } catch (error) {
            throw new ActionableError(
              `Failed to get session info: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;
      }

      case "release-session": {
        if (args.length === 0) {
          throw new ActionableError("release-session requires a session ID argument");
        }
        const sessionId = args[0];

        // Check if running in daemon process
        const daemonState = manager.getDaemonState();
        if (daemonState.isInitialized()) {
          // Running inside daemon process
          const sessionManager = daemonState.getSessionManager();
          const pool = daemonState.getDevicePool();
          const session = sessionManager.getSession(sessionId);
          if (!session) {
            throw new ActionableError(`Session not found: ${sessionId}`);
          }
          const deviceId = session.assignedDevice;
          sessionManager.releaseSession(sessionId);
          pool.releaseDevice(deviceId, sessionId);
          console.log(`Session ${sessionId} released`);
          console.log(`Device ${deviceId} is now available`);
        } else {
          // Running from CLI - query daemon via socket
          const client = manager.createClient();
          try {
            await client.connect();
            await client.callDaemonMethod("daemon/releaseSession", { sessionId });
            console.log(`Session ${sessionId} released`);
            await client.close();
          } catch (error) {
            throw new ActionableError(
              `Failed to release session: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;
      }

      default:
        console.error(`Unknown daemon command: ${command}`);
        console.log("\nAvailable commands:");
        console.log("  start                 Start the daemon");
        console.log("  stop                  Stop the daemon");
        console.log("  status                Check daemon status");
        console.log("  restart               Restart the daemon");
        console.log("  health                Check daemon health");
        console.log("  diagnose              Run full diagnostics");
        console.log("  available-devices     Query device pool status");
        console.log("  session-info <id>     Get information about a session");
        console.log("  release-session <id>  Release a session and free its device");
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof ActionableError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}
