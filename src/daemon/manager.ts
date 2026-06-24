import { spawn, execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, openSync, closeSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger";
import { ActionableError } from "../models";
import {
  PID_FILE_PATH,
  SOCKET_PATH,
  LOCK_FILE_PATH,
  DAEMON_STARTUP_TIMEOUT_MS,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  DAEMON_VERSION,
} from "./constants";
import { DaemonStatus, PidFileData, DaemonOptions } from "./types";
import {
  getDaemonHealthReport,
  formatHealthReport,
  runSocketDiagnostics,
  formatSocketDiagnostics,
} from "./debugTools";
import { DaemonClient, type DaemonClientFactory, type DaemonClientLike } from "./client";
import { DaemonState, type DaemonStateLike } from "./daemonState";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { cleanupDaemonFiles } from "./daemonFiles";

/**
 * Check that bunx is available on PATH.
 * Returns "bunx" if found, or null if not.
 */
function resolvePackageRunner(): string | null {
  try {
    execSync("which bunx", { stdio: "ignore" });
    return "bunx";
  } catch {
    return null;
  }
}

/**
 * Write a message to stderr so it never corrupts the MCP stdio channel.
 * When the MCP server runs in proxy mode, stdout carries JSON-RPC traffic.
 * All daemon lifecycle messages must go to stderr (or the file logger).
 */
function stderrLog(message: string): void {
  process.stderr.write(message + "\n");
}

export interface DaemonLaunchCommand {
  command: string;
  args: string[];
}

function resolvePackageSpecifier(version: string): string {
  const trimmedVersion = version.trim();
  if (trimmedVersion.length === 0 || trimmedVersion === "unknown") {
    throw new ActionableError(
      "Cannot spawn AutoMobile daemon via bunx because the current package version is unknown. Run from an installed auto-mobile binary or set MCP_SERVER_VERSION."
    );
  }
  return `@kaeawc/auto-mobile@${trimmedVersion}`;
}

export function resolveDaemonLaunchCommand(
  entryScript: string | undefined = process.argv[1],
  packageRunner: string | null = resolvePackageRunner(),
  version: string = DAEMON_VERSION
): DaemonLaunchCommand {
  if (entryScript) {
    return {
      command: process.execPath,
      args: [entryScript, "--daemon-mode"],
    };
  }

  if (packageRunner) {
    return {
      command: packageRunner,
      args: ["-y", resolvePackageSpecifier(version), "--daemon-mode"],
    };
  }

  return {
    command: "auto-mobile",
    args: ["--daemon-mode"],
  };
}

/**
 * Surface of DaemonManager used by clients (e.g. DaemonMcpProxy).
 * Allows injecting fakes in tests without subclassing the concrete class.
 */
export interface DaemonManagerLike {
  status(): Promise<DaemonStatus>;
  start(options?: DaemonOptions): Promise<void>;
  restart(options?: DaemonOptions): Promise<void>;
  waitForReady(timeout: number): Promise<boolean>;
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

  constructor(
    clientFactory: DaemonClientFactory | undefined = undefined,
    stateProvider: () => DaemonStateLike = () => DaemonState.getInstance(),
    timer: Timer = defaultTimer,
    lockFilePath: string = LOCK_FILE_PATH,
    pidFilePath: string = PID_FILE_PATH,
    socketPath: string = SOCKET_PATH
  ) {
    this.stateProvider = stateProvider;
    this.timer = timer;
    this.lockFilePath = lockFilePath;
    this.pidFilePath = pidFilePath;
    this.socketPath = socketPath;
    this.clientFactory = clientFactory ?? (() => new DaemonClient(this.socketPath));
  }

  /**
   * Acquire an exclusive file lock for daemon start/stop coordination.
   * Uses O_CREAT | O_EXCL for atomic creation. Returns true if lock acquired.
   * Cleans up stale locks from dead processes.
   */
  acquireLock(): boolean {
    if (this.writeLockFile()) {
      return true;
    }
    // Lock file exists — check if owning process is alive
    try {
      const content = readFileSync(this.lockFilePath, "utf-8").trim();
      if (content.length === 0) {
        // Empty file — another process just created it and hasn't written PID yet.
        // Treat as actively held to avoid race condition.
        return false;
      }
      const ownerPid = parseInt(content, 10);
      if (isNaN(ownerPid)) {
        // Unreadable PID — treat as actively held (writer may still be writing)
        return false;
      }
      if (this.isProcessRunning(ownerPid)) {
        return false;
      }
      // Owner is dead — stale lock, remove and retry once
      unlinkSync(this.lockFilePath);
      return this.writeLockFile();
    } catch {
      return false;
    }
  }

  /**
   * Atomically create the lock file with our PID. Returns true on success.
   */
  private writeLockFile(): boolean {
    try {
      const fd = openSync(this.lockFilePath, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Release the file lock.
   */
  releaseLock(): void {
    try {
      unlinkSync(this.lockFilePath);
    } catch {
      // Best-effort cleanup
    }
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
      // Use ps to find all auto-mobile daemon processes for current user
      const psOutput = execSync(
        `ps aux | grep -E "auto-mobile.*--daemon-mode|dist/src/index.js --daemon-mode" | grep -v grep`,
        { encoding: "utf-8" }
      );

      const pids: number[] = [];
      const lines = psOutput.trim().split("\n").filter(line => line.trim());

      for (const line of lines) {
        // Parse PID from ps output (second column)
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const pid = parseInt(parts[1], 10);
          if (!isNaN(pid) && pid !== process.pid) {
            pids.push(pid);
          }
        }
      }

      return pids;
    } catch (error) {
      // No matching processes found or command failed
      return [];
    }
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
    // Check for any running daemon processes from ANY worktree
    const otherDaemons = this.findAllDaemonProcesses();
    if (otherDaemons.length > 0) {
      stderrLog(
        `\nWARNING: Found ${otherDaemons.length} other auto-mobile daemon process(es) running:`
      );
      for (const pid of otherDaemons) {
        stderrLog(`  - PID ${pid}`);
      }
      stderrLog(
        `\nThese may be from other worktrees and can cause device pool conflicts.`
      );
      stderrLog(`Stopping all other daemons before starting new one...`);

      for (const pid of otherDaemons) {
        try {
          process.kill(pid, "SIGTERM");
          stderrLog(`  Stopped PID ${pid}`);
        } catch (error) {
          stderrLog(`  Failed to stop PID ${pid}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Wait for processes to terminate
      await this.timer.sleep(1000);
    }

    // Enforce single daemon policy: stop any existing daemon before starting
    // This ensures only one daemon runs on the host system (per user)
    const status = await this.status();
    if (status.running) {
      stderrLog(
        `Found existing daemon (PID ${status.pid}, port ${status.port}), stopping it...`
      );
      await this.stop();
      // Wait briefly for cleanup
      await this.timer.sleep(500);
    }

    // Clean up stale socket and PID files from previous sessions
    await cleanupDaemonFiles({ pidFilePath: this.pidFilePath });

    stderrLog("Starting AutoMobile daemon...");

    // Resolve the current binary so the daemon uses the same version.
    // process.argv[1] is the entry script (e.g. dist/src/index.js).
    // Falls back to bunx to avoid requiring a global install.
    const { command: autoMobileCmd, args } = resolveDaemonLaunchCommand();
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
    if (options.dismissKeyboardAfterInput) {
      args.push("--dismiss-keyboard-after-input");
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

    // Create secure temp directory with random suffix to prevent symlink attacks
    const tempDir = mkdtempSync(join(tmpdir(), "auto-mobile-daemon-"));
    const logPath = join(tempDir, "daemon.log");
    // Open with restricted permissions (0o600 = owner read/write only)
    const logFd = openSync(logPath, "w", 0o600);

    // Propagate any non-default file paths to the child so its constants module
    // resolves to the same locations this manager polls.
    const childEnv = { ...process.env };
    if (this.pidFilePath !== PID_FILE_PATH) {
      childEnv.AUTOMOBILE_DAEMON_PID_FILE_PATH = this.pidFilePath;
    }
    if (this.lockFilePath !== LOCK_FILE_PATH) {
      childEnv.AUTOMOBILE_DAEMON_LOCK_FILE_PATH = this.lockFilePath;
    }
    if (this.socketPath !== SOCKET_PATH) {
      childEnv.AUTOMOBILE_DAEMON_SOCKET_PATH = this.socketPath;
    }

    const daemonProcess = spawn(autoMobileCmd, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd], // Write stdout/stderr to log file
      shell: true, // Use shell to resolve command from PATH
      env: childEnv,
    });

    // Close our reference to the log file (daemon process still has it open)
    closeSync(logFd);

    // Unref so parent process can exit
    daemonProcess.unref();

    // Wait for daemon to be ready
    const ready = await this.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new ActionableError(
        `Daemon failed to start within ${DAEMON_STARTUP_TIMEOUT_MS}ms`
      );
    }

    const newStatus = await this.status();
    stderrLog(
      `Daemon started successfully (PID ${newStatus.pid}, port ${newStatus.port})`
    );
    stderrLog(`Socket: ${newStatus.socketPath}`);
    stderrLog(`Logs: ${logPath}`);
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

        // Wait a bit more
        await this.timer.sleep(1000);
      }

      await cleanupDaemonFiles({
        pidFilePath: this.pidFilePath,
        socketPaths: this.cleanupSocketPaths(status.socketPath),
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
        });
        return { running: false };
      }

      return {
        running: true,
        pid: pidData.pid,
        port: pidData.port,
        socketPath: pidData.socketPath,
        sockets: pidData.sockets,
        startedAt: pidData.startedAt,
        version: pidData.version,
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
    await this.stop();
    // Wait a bit before starting
    await this.timer.sleep(1000);
    await this.start(options);
  }

  /**
   * Wait for daemon to be ready (socket listening)
   */
  async waitForReady(timeout: number): Promise<boolean> {
    const startTime = this.timer.now();
    const pollInterval = 100; // Poll every 100ms

    while (this.timer.now() - startTime < timeout) {
      if (existsSync(this.socketPath)) {
        const status = await this.status();
        if (status.running) {
          if (await this.verifyDaemonConnection()) {
            return true;
          }
          await this.removeInvalidSocketPath();
        }
      }

      await this.timer.sleep(pollInterval);
    }

    return false;
  }

  private async verifyDaemonConnection(): Promise<boolean> {
    const client = this.createClient();
    try {
      await client.connect();
      return true;
    } catch (error) {
      logger.debug(`Daemon socket readiness probe failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      try {
        await client.close();
      } catch (error) {
        logger.debug(`Failed to close daemon readiness probe client: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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

    return false;
  }

  /**
   * Check if a process is running
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without actually sending a signal
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
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
      return null;
    }
  }
}

function parseDaemonArgs(args: string[]): DaemonOptions {
  const options: DaemonOptions = {};
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
    } else if (args[i] === "--network-mockable") {
      options.networkMockable = true;
    } else if (args[i] === "--dismiss-keyboard-after-input") {
      options.dismissKeyboardAfterInput = true;
    } else if (args[i] === "--no-ui-perf-mode") {
      options.noUiPerfMode = true;
    } else if (args[i] === "--no-navigation-screenshots") {
      options.noNavigationScreenshots = true;
    } else if (args[i] === "--no-waitfor-polling-overhead") {
      options.noWaitForPollingOverhead = true;
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
          console.log(`  Version: ${status.version || "unknown"}`);
          console.log(
            `  Started: ${status.startedAt ? new Date(status.startedAt).toISOString() : "unknown"}`
          );

          // Check for other daemon processes (exclude current daemon)
          const otherDaemons = manager.findAllDaemonProcesses().filter(pid => pid !== status.pid);
          if (otherDaemons.length > 0) {
            console.log(
              `\n⚠️  WARNING: Found ${otherDaemons.length} other daemon process(es) from other worktrees:`
            );
            for (const pid of otherDaemons) {
              console.log(`  - PID ${pid}`);
            }
            console.log(
              `\nThese can cause device pool conflicts. Run 'bunx @kaeawc/auto-mobile@latest --daemon restart' to stop them.`
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
        const formatPoolStats = (stats?: { idle: number; assigned: number; error: number; total: number }) => (
          JSON.stringify({
            availableDevices: stats?.idle ?? 0,
            totalDevices: stats?.total ?? 0,
            assignedDevices: stats?.assigned ?? 0,
            errorDevices: stats?.error ?? 0,
          })
        );

        // Check if running in daemon process
        const daemonState = manager.getDaemonState();
        if (daemonState.isInitialized()) {
          // Running inside daemon process
          const pool = daemonState.getDevicePool();
          console.log(formatPoolStats(pool.getStats()));
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
              console.log(formatPoolStats(data?.poolStatus));
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
          pool.releaseDevice(deviceId);
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
