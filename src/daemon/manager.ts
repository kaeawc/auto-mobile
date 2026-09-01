import { errorMessage } from "../utils/describeUnknownError";
import { execSync, type ChildProcess } from "node:child_process";
import { open, readFile, rm, unlink } from "node:fs/promises";
import { existsSync, openSync, closeSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { devNull, tmpdir } from "node:os";
import { isStructuredLoggingEnabled, logger, resolveAutomobileLogSink } from "../utils/logger";
import { resolveDaemonInstallSpecifier } from "../constants/release";
import {
  INCOMPLETE_EXTRACTION_CODE,
  INCOMPLETE_EXTRACTION_EXIT_CODE,
} from "../db/migrationDependencyIntegrity";
import { ensureSecureLogsDirSync, resolveAutoMobileLogsDir } from "../utils/tempDir";
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
  DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS,
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
import { cleanupDaemonFiles, isProcessRunning as isDaemonProcessRunning } from "./daemonFiles";
import { parseLockContent, releaseExclusiveLock, tryAcquireExclusiveLock } from "../utils/fileLock";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
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
export function relayDaemonStderr(daemonProcess: ChildProcess): void {
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
  options: { encoding: "utf-8"; maxBuffer: number },
) => string;

function normalizeProcessCommand(command: string): string {
  return command.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function invokedCommand(command: string): string {
  const shellInvocation = command
    .trim()
    .match(/(?:^|\s)(?:-c|\/c|-(?:command|encodedcommand|c|ec))\s+["']?(.+)$/i);
  return shellInvocation?.[1].trim() ?? command.trim();
}

function isAutoMobileDaemonCommand(command: string): boolean {
  const normalizedCommand = normalizeProcessCommand(command);
  const invocation = invokedCommand(normalizedCommand);
  if (!/(?:^|\s)--daemon-mode(?:\s|["']|$)/.test(invocation)) {
    return false;
  }

  const runsBundledEntrypoint =
    /(?:^|["'\s\\/])(?:bun|node)(?:\.exe)?(?:\s|["'])/.test(invocation) &&
    /(?:^|["'\s])[^"'\s]*\/(?:@kaeawc\/)?auto-mobile\/dist\/src\/index\.js(?:\s|["']|$)/.test(
      invocation,
    );
  const runsPublishedPackage =
    /^(?:"?[^"'\s]*\/)?(?:bunx|npx)(?:\.exe)?\s+(?:(?:-y|--yes|--bun|--no-cache)\s+)*@kaeawc\/auto-mobile(?:@[^\s"']+)?(?:\s|["']|$)/.test(
      invocation,
    ) ||
    /^(?:"?[^"'\s]*\/)?bun(?:\.exe)?\s+x\s+(?:(?:-y|--yes|--bun|--no-cache)\s+)*@kaeawc\/auto-mobile(?:@[^\s"']+)?(?:\s|["']|$)/.test(
      invocation,
    );
  const runsStandaloneBinary = /^(?:"?[^"'\s]*\/)?auto-mobile(?:\.exe)?(?:\s|$)/i.test(invocation);

  return runsBundledEntrypoint || runsPublishedPackage || runsStandaloneBinary;
}

function isShellCommandWrapper(command: string): boolean {
  const normalizedCommand = normalizeProcessCommand(command);
  const trimmedCommand = normalizedCommand.trim();
  const executable = trimmedCommand.startsWith('"')
    ? trimmedCommand.slice(1, trimmedCommand.indexOf('"', 1))
    : (trimmedCommand.split(/\s+/, 1)[0] ?? "");

  if (/(^|\/)(?:ba|da|z)?sh$/.test(executable) && normalizedCommand.includes(" -c ")) {
    return true;
  }

  if (/(^|\/)cmd(?:\.exe)?$/i.test(executable) && /(?:^|\s)\/c(?:\s|$)/i.test(normalizedCommand)) {
    return true;
  }

  return (
    /(^|\/)(?:powershell|pwsh)(?:\.exe)?$/i.test(executable) &&
    /(?:^|\s)-(?:command|encodedcommand|c|ec)(?:\s|$)/i.test(normalizedCommand)
  );
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

function parseWindowsProcessTableEntry(
  entry: WindowsProcessTableEntry,
): DaemonProcessRecord | undefined {
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

export class WindowsDaemonProcessFinder
  implements DaemonProcessFinder, DaemonProcessLivenessChecker
{
  constructor(private readonly runCommand: ProcessTableCommandRunner = execSync) {}

  findDaemonProcesses(): DaemonProcessRecord[] {
    const processTableJson = this.runCommand(
      'powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"',
      {
        encoding: "utf-8",
        maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
      },
    );
    return parseWindowsDaemonProcessTable(processTableJson);
  }

  isProcessRunning(pid: number): boolean {
    return isDaemonProcessRunning(pid);
  }
}

export function createDefaultDaemonProcessFinder(
  platform: NodeJS.Platform = process.platform,
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
  return (
    typeof (value as Partial<DaemonProcessLivenessChecker> | undefined)?.isProcessRunning ===
    "function"
  );
}

const MAX_DAEMON_STARTUP_LOG_BYTES = 4000;

/**
 * Budget for the confirming socket probe once the process a readiness wait was
 * waiting on has died (issue #5878). A daemon that genuinely published its socket
 * answers a probe near-instantly, so this only needs to cover the readiness
 * probe's own retry/backoff — not a real cold start. Capping it here keeps a
 * stale or stalling socket from consuming the client's whole `tools/list`
 * deadline before the wait abandons: without the cap, the per-poll probe is
 * handed the full remaining startup budget and runs before the liveness check
 * gets another turn.
 */
const ABANDONED_WAIT_CONFIRM_TIMEOUT_MS = 1000;

/**
 * Cadence at which the liveness watchdog re-samples the "keep waiting" predicate
 * while a full-budget readiness probe is in flight (issue #5904). A per-poll
 * precheck only samples liveness between probes; if the holder dies *during* a
 * probe whose `connect()` stalls (an accepts-but-never-responds socket), nothing
 * interrupts that probe and it can absorb the client's whole `tools/list`
 * deadline before the actionable error is produced. The watchdog aborts the probe
 * the instant no live holder remains. Matched to the readiness poll interval so it
 * reacts within one poll without hammering the process table.
 */
const LIVENESS_WATCHDOG_INTERVAL_MS = 100;

/**
 * Maximum duration of one socket probe while waiting on another startup-lock
 * holder. A stale socket owned by an unrelated daemon must not pin the entire
 * readiness budget (issue #5928).
 */
const LOCK_HOLDER_PROBE_TIMEOUT_MS = 1000;

/**
 * A snapshot of the daemon startup lock's current holder, as read from the lock
 * file. `token` carries the holder's per-instance owner token (issue #5904) so a
 * replacement holder is distinguishable from the prior one even under PID reuse.
 */
interface StartupLockHolder {
  present: boolean;
  livePid: number | undefined;
  token: string | undefined;
}

/**
 * Surface of DaemonManager used by clients (e.g. DaemonMcpProxy).
 * Allows injecting fakes in tests without subclassing the concrete class.
 */
export interface DaemonManagerLike {
  status(): Promise<DaemonStatus>;
  start(options?: DaemonOptions): Promise<void>;
  restart(options?: DaemonOptions): Promise<void>;
  waitForReady(
    timeout: number,
    signal?: AbortSignal,
    shouldContinueWaiting?: () => boolean,
    maxProbeDurationMs?: number,
  ): Promise<boolean>;
  /**
   * Whether the daemon startup lock is held by a still-live process — used as the
   * early-exit predicate for readiness waits that block on another process bringing
   * up the daemon, so a crashed holder is not waited on for the full budget while a
   * live one keeps it (issue #5878).
   */
  isStartupLockHeldByLiveProcess(): boolean;
  /**
   * Wait for the current live startup-lock holder to publish a connectable socket,
   * re-arbitrating across replacement holders under one deadline (issue #5904).
   * Returns false only once no live holder remains, so the caller delivers its
   * actionable error rather than racing the client's `tools/list` deadline.
   */
  waitForLockHolderReadiness(timeoutMs: number): Promise<boolean>;
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
  private heldLockLogPath: string | undefined;
  /**
   * A per-instance owner token written into the startup lock alongside the PID
   * (issue #5904). It distinguishes a genuinely new lock holder from the prior one
   * even when the OS recycled the prior holder's PID, or when a *different*
   * `DaemonManager` instance in this same process reacquires the lock with an
   * identical `process.pid` — cases a PID-only identity check reads as "same
   * holder" and stops waiting on. Generated from the injected `IdGenerator` so it
   * is the one canonical randomness primitive rather than an ad-hoc UUID path.
   */
  private readonly startupLockOwnerToken: string;

  constructor(
    clientFactory: DaemonClientFactory | undefined = undefined,
    stateProvider: () => DaemonStateLike = () => DaemonState.getInstance(),
    timer: Timer = defaultTimer,
    lockFilePath: string = LOCK_FILE_PATH,
    pidFilePath: string = PID_FILE_PATH,
    socketPath: string = SOCKET_PATH,
    processFinderOrSpawner:
      | DaemonProcessFinder
      | DaemonProcessSpawner = createDefaultDaemonProcessFinder(),
    processSpawner: DaemonProcessSpawner | undefined = undefined,
    extractionCleaner: ExtractionCleaner = fileSystemExtractionCleaner,
    launcher: DaemonLauncher | (() => DaemonLaunchCommand) | undefined = undefined,
    processSignaler: DaemonProcessSignaler = defaultDaemonProcessSignaler,
    idGenerator: IdGenerator = defaultIdGenerator,
  ) {
    this.startupLockOwnerToken = idGenerator.next();
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
    this.launcher =
      (typeof launcher === "object" ? launcher : undefined) ??
      new DaemonLauncher({
        spawn: processSpawner?.spawn.bind(processSpawner),
        timer,
      });
    this.fallbackLauncher = new DaemonLauncher({
      entryScript: null,
      spawn: processSpawner?.spawn.bind(processSpawner),
      timer,
    });
    this.clientFactory =
      clientFactory ?? (() => new DaemonClient(this.socketPath, undefined, timer));
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
    const logPath = this.daemonLaunchLogPath();
    const acquired = tryAcquireExclusiveLock(this.lockFilePath, {
      isProcessRunning: (pid) => this.isProcessRunning(pid),
      // Written on line 2 so a follower can tell a replacement holder apart from
      // the one it was already waiting on even under PID reuse (issue #5904).
      // `reclaimOwnPid` stays false (the daemon's documented same-process contract),
      // so the token does not change acquire's stale-reclaim decision — it only
      // feeds the replacement-identity read in `readStartupLockHolder`.
      ownerToken: this.startupLockOwnerToken,
      metadata: Buffer.from(logPath, "utf8").toString("base64url"),
    });
    this.heldLockLogPath = acquired ? logPath : undefined;
    return acquired;
  }

  /**
   * Release the file lock. Compare-and-delete: only removes the file if it still
   * holds our PID, so it can't delete a lock another opener reclaimed.
   */
  releaseLock(): void {
    // Pass the token so release is incarnation-aware and symmetric with acquire: a
    // same-PID lock bearing a DIFFERENT token belongs to another instance/incarnation
    // that recycled our PID and must not be deleted (issue #5904). A lock with no
    // token line (a pre-token incarnation) is still treated as ours on a PID match.
    releaseExclusiveLock(this.lockFilePath, process.pid, this.startupLockOwnerToken);
    this.heldLockLogPath = undefined;
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
      throw new ActionableError(`Failed to inspect daemon process table: ${errorMessage(error)}`);
    }
  }

  findOtherDaemonProcesses(activeDaemonPid: number | undefined): number[] {
    return this.findLiveDaemonProcesses().filter((pid) => pid !== activeDaemonPid);
  }

  findLiveDaemonProcesses(): number[] {
    return this.findAllDaemonProcesses().filter((pid) => this.isProcessRunning(pid));
  }

  private normalizeDaemonProcessRecords(records: DaemonProcessRecord[]): number[] {
    const wrapperPids = new Set<number>();
    const childPpids = new Set(records.map((record) => record.ppid));

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
    if (!this.acquireLock()) {
      await this.startByAwaitingLockHolder(options);
      return;
    }

    try {
      await this.startUnlocked(options);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Resolve a start where another process already holds the startup lock.
   *
   * Loops: wait for the current holder to publish the socket — exiting the wait the
   * instant that holder dies, so a crashed holder cannot burn the client's ~30s
   * `tools/list` deadline (issue #5878) — then, if it died, take over the lock, or
   * if a *different* live process reclaimed it, wait on that replacement. A holder
   * that stays alive keeps the full DAEMON_STARTUP_TIMEOUT_MS so a legitimate slow
   * cold start by another process is not abandoned. Only once no live holder remains
   * and a bounded readiness confirm still fails do we report the lock-holder startup
   * failure — that confirm closes the race where a holder publishes its socket and
   * releases its lock in the window between a poll's socket check and its liveness
   * check.
   */
  private async startByAwaitingLockHolder(options: DaemonOptions): Promise<void> {
    let holderLogPath: string | null = null;
    let waitedOnHolder = this.readStartupLockHolder();

    // ONE arbitration deadline across every holder, replacements included, and the
    // final confirm bounded by whatever time is left under it — so a chain of
    // holders (A replaced by B near A's deadline) plus the confirm cannot push the
    // failure past the client's ~30s `tools/list` deadline, which would hide the
    // very error this change exists to deliver (issue #5878). The loop is bounded by
    // this deadline rather than a fixed iteration count, so a legitimate replacement
    // that reclaims the lock with time still on the clock is not cut off prematurely.
    const arbitrationDeadline = this.timer.now() + DAEMON_STARTUP_TIMEOUT_MS;

    // A wait on a live holder polls on an interval and so consumes real time, and
    // a dead holder is either taken over or ends the loop — so the arbitration
    // deadline bounds the number of iterations; no separate count cap is needed
    // (and a count cap would wrongly cut off a legitimate replacement that reclaims
    // the lock with time still on the clock).
    while (this.remainingTime(arbitrationDeadline) > 0) {
      const remaining = this.remainingTime(arbitrationDeadline);
      stderrLog("Another process is starting the daemon, waiting...");
      // Capture diagnostics while the current holder still holds the lock, so they
      // survive into the failure message if the holder later releases on failure.
      holderLogPath = (await this.getLockHolderStartupLogPath()) ?? holderLogPath;
      const ready = await this.waitForReady(
        remaining,
        undefined,
        () => this.isStillWaitingOnStartupLockHolder(waitedOnHolder),
        LOCK_HOLDER_PROBE_TIMEOUT_MS,
      );
      if (ready) {
        stderrLog("Daemon started by another process");
        return;
      }

      // The holder we waited on is gone — take over its start.
      if (this.acquireLock()) {
        stderrLog("Previous lock holder failed, taking over daemon start...");
        try {
          await this.startUnlocked(options);
        } finally {
          this.releaseLock();
        }
        return;
      }

      // We could not take over, so the lock is still held. Keep waiting only for a
      // genuinely different live holder (a replacement that reclaimed the lock while
      // the prior one died); a stuck same holder or a now-dead lock ends the loop.
      // Identity is by owner token, not PID, so a replacement that reused the prior
      // holder's PID — OS recycling, or a same-process sibling manager instance — is
      // still recognized as a replacement rather than read as the same stuck holder
      // (issue #5904).
      const current = this.readStartupLockHolder();
      if (current.livePid === undefined || this.isSameStartupLockHolder(current, waitedOnHolder)) {
        break;
      }
      waitedOnHolder = current;
      stderrLog("Startup lock reclaimed by another process, waiting again...");
    }

    // The holder may have published its socket and released its lock in the window
    // between a poll's socket check and its liveness check, so confirm reachability
    // directly before reporting failure. Use verifyDaemonConnection rather than
    // waitForReady: it is a bounded, NON-destructive probe that never unlinks a
    // socket, so a healthy-but-slow daemon that just came up is not torn down. Cap
    // it to whatever time is left under the arbitration deadline so it cannot push
    // total elapsed past the client deadline (issue #5878); when the loop already
    // consumed the whole budget there is no release-race window to catch anyway.
    const confirmBudget = Math.min(
      ABANDONED_WAIT_CONFIRM_TIMEOUT_MS,
      this.remainingTime(arbitrationDeadline),
    );
    if (
      confirmBudget > 0 &&
      existsSync(this.socketPath) &&
      (await this.verifyDaemonConnection(confirmBudget))
    ) {
      stderrLog("Daemon became ready before reporting startup failure");
      return;
    }
    throw await this.createLockHolderStartupFailure(holderLogPath);
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
        `Found ${liveDaemons.length} live auto-mobile daemon process(es) without a usable PID record; waiting for one to become ready...`,
      );
      for (const pid of liveDaemons) {
        stderrLog(`  - PID ${pid}`);
      }
      // Bound this reachability wait well under a client's request timeout. It is
      // nested inside a `tools/list` that clients cut off at ~30s
      // (DAEMON_STARTUP_TIMEOUT_MS); if it consumed the full startup budget the
      // actionable error below would be produced only as the client's own
      // deadline expired, so the client would see an AutoMobile server with zero
      // tools and no error text instead (issue #5871). A daemon that has not
      // become reachable within this shorter budget is one the client is better
      // off hearing about now than waiting on.
      if (await this.waitForExistingDaemon(DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS)) {
        stderrLog("Reusing existing responsive daemon");
        return;
      }

      throw new ActionableError(
        `Found live AutoMobile daemon process(es) (${liveDaemons.join(", ")}) but none became reachable within ` +
          `${DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS}ms. Refusing to terminate a live daemon during start; ` +
          `inspect it or run \`bunx ${resolveDaemonInstallSpecifier()} --daemon restart\` explicitly.`,
      );
    }

    // Clean up stale socket and PID files from previous sessions
    await cleanupDaemonFiles({ pidFilePath: this.pidFilePath });

    stderrLog("Starting AutoMobile daemon...");

    // Resolve the current binary so the daemon uses the same version.
    // process.argv[1] is the entry script (e.g. dist/src/index.js).
    // Falls back to bunx to avoid requiring a global install.
    let { command: autoMobileCmd, args } = this.withDaemonOptions(
      this.resolveLaunchCommand(),
      options,
    );

    // Redirect the detached daemon's stdout/stderr into the configured logs dir
    // (`~/.auto-mobile/logs` by default) rather than an ephemeral
    // `mkdtemp(tmpdir())` directory. Under bunx the temp tree is reaped while the
    // daemon keeps this fd open, which previously left the on-disk log unlinked
    // and post-hoc debugging impossible (issue #2724). The logs dir is created
    // owner-only (0o700) by ensureSecureLogsDirSync, so a fixed, predictable
    // filename inside it is not exposed to other users.
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
    const logSink = resolveAutomobileLogSink(childEnv);
    const capturesLaunchOutput = logSink !== "stderr";
    const logPath = capturesLaunchOutput
      ? (this.heldLockLogPath ?? this.daemonLaunchLogPath())
      : devNull;
    if (capturesLaunchOutput) {
      ensureSecureLogsDirSync();
    }
    // Open with restricted permissions (0o600 = owner read/write only).
    // Stderr-only containers deliberately skip the file capture and do not need
    // a writable AutoMobile data directory.
    const logFd = openSync(logPath, "w", 0o600);

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
              stdio: [
                "ignore",
                capturesLaunchOutput ? logFd : "ignore",
                logSink === "stderr" || logSink === "both" ? "pipe" : logFd,
              ],
              env: childEnv,
            },
            onSpawn: logSink === "stderr" || logSink === "both" ? relayDaemonStderr : undefined,
            timeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
            waitForReady: (timeoutMs, signal) => this.waitForReady(timeoutMs, signal),
            isReadyForLaunchedProcess: (pid, timeoutMs, signal) =>
              this.isLaunchedProcessReady(pid, timeoutMs, signal),
            formatFailure: (summary) => this.createDaemonStartupFailure(summary, logPath),
            formatExitFailure: (code, signal) =>
              this.createDaemonExitFailure(code, signal, logPath),
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
            removed = entryScript
              ? await this.extractionCleaner.removeExtractionForEntryScript(entryScript)
              : false;
          } catch (cleanupError) {
            throw new ActionableError(
              `${this.describeError(error)}\nFailed to remove incomplete extraction before retry: ${this.describeError(cleanupError)}`,
            );
          }
          if (!removed) {
            throw error;
          }
          ({ command: autoMobileCmd, args } = this.withDaemonOptions(
            this.fallbackLauncher.resolveCommand(),
            options,
          ));
          stderrLog(
            `Detected incomplete daemon package extraction (${INCOMPLETE_EXTRACTION_CODE}); removed it and retrying once...`,
          );
        }
      }
    } finally {
      // Close our reference to the log file (daemon process still has it open)
      closeSync(logFd);
    }

    const newStatus = await this.status();
    stderrLog(`Daemon started successfully (PID ${newStatus.pid}, port ${newStatus.port})`);
    stderrLog(`Socket: ${newStatus.socketPath}`);
    stderrLog(`Logs: ${logPath}`);
  }

  private withDaemonOptions(
    launch: DaemonLaunchCommand,
    options: DaemonOptions,
  ): DaemonLaunchCommand {
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
      args.push("--a11y-level", options.accessibilityLevel);
    }
    if (options.accessibilityFailureMode) {
      args.push("--a11y-failure-mode", options.accessibilityFailureMode);
    }
    if (options.accessibilityMinSeverity) {
      args.push("--a11y-min-severity", options.accessibilityMinSeverity);
    }
    if (options.accessibilityUseBaseline) {
      args.push("--a11y-use-baseline");
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

  private async createLockHolderStartupFailure(retainedLogPath?: string | null): Promise<Error> {
    const summary = "Another process is starting the daemon but it failed to become ready";
    const logPath = retainedLogPath ?? (await this.getLockHolderStartupLogPath());
    if (!logPath) {
      return new ActionableError(
        `${summary}; the startup lock did not contain a usable holder PID for diagnostics.`,
      );
    }
    return new ActionableError(await this.formatDaemonStartupFailure(summary, logPath));
  }

  /**
   * Read the current owner of the daemon startup lock.
   *
   * `present` is true while there is a holder worth waiting for — a live PID, or a
   * lock file mid-write whose PID is not yet readable; it is false once the lock is
   * gone or its holder has died. `livePid` is that holder's PID when it is both
   * readable and alive, else `undefined`. `token` is the holder's per-instance owner
   * token (issue #5904) when present, so a caller can tell a *replacement* holder
   * from the same one it was already waiting on even when the PID is identical (OS
   * PID reuse, or a different `DaemonManager` instance in this same process) — a
   * gap a PID-only comparison misses. See {@link isSameStartupLockHolder}.
   *
   * Reuses the injected liveness checker and the shared lock format so there is one
   * canonical primitive per concern rather than a second PID reader (issue #5878).
   */
  private readStartupLockHolder(): StartupLockHolder {
    let content: string;
    try {
      content = readFileSync(this.lockFilePath, "utf-8").trim();
    } catch (error) {
      // Lock file is gone: the holder released it (finished or crashed). Nothing
      // left to wait on — stop so start() can re-acquire or surface its failure.
      logger.debug(
        `[DaemonManager] Startup lock unreadable while waiting for holder: ${this.describeError(error)}`,
      );
      return { present: false, livePid: undefined, token: undefined };
    }
    if (content.length === 0) {
      // A holder created the lock but has not written its PID yet (mirrors the
      // fileLock mid-write window); treat as still held so we do not abandon it,
      // but with no comparable identity yet.
      return { present: true, livePid: undefined, token: undefined };
    }
    const { pid, token } = parseLockContent(content);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      // Unreadable PID — a holder may still be filling it in; keep waiting.
      return { present: true, livePid: undefined, token };
    }
    return this.isProcessRunning(pid)
      ? { present: true, livePid: pid, token }
      : { present: false, livePid: undefined, token };
  }

  /**
   * Whether two startup-lock reads refer to the same holder (issue #5904).
   *
   * Prefers owner-token identity: a replacement holder that reused the prior
   * holder's PID — the OS recycling it, or a *different* `DaemonManager` instance in
   * this same process re-acquiring with an identical `process.pid` — writes a
   * different token and so reads as a genuinely new holder still worth waiting on,
   * which a bare PID comparison would wrongly collapse to "same stuck holder". Falls
   * back to PID identity only when a token is missing on either side (a pre-token
   * lock, or a holder still mid-write), preserving the earlier PID-only behavior.
   */
  private isSameStartupLockHolder(a: StartupLockHolder, b: StartupLockHolder): boolean {
    if (a.token !== undefined && b.token !== undefined) {
      return a.token === b.token;
    }
    if (a.token !== b.token) {
      return false;
    }
    return a.livePid !== undefined && a.livePid === b.livePid;
  }

  /**
   * Whether the daemon startup lock is currently held by a still-live process.
   *
   * Early-exit predicate for the readiness waits that block on another process
   * bringing up the daemon (in {@link start} and in `DaemonMcpProxy.startDaemon`'s
   * "reports running but socket not yet published" branch). A plain readiness wait
   * polls only the socket, so when the holder crashes — or fails and releases the
   * lock — it keeps polling for the full DAEMON_STARTUP_TIMEOUT_MS even though
   * nothing will ever become ready, and the actionable failure is produced only as
   * the client's own `tools/list` deadline expires (issue #5878). Giving up the
   * instant the holder is gone makes that error deliverable, while a holder that is
   * still alive keeps the full budget so a legitimate slow cold start by another
   * process is not abandoned.
   */
  isStartupLockHeldByLiveProcess(): boolean {
    return this.readStartupLockHolder().present;
  }

  private isStillWaitingOnStartupLockHolder(waitedOnHolder: StartupLockHolder): boolean {
    const current = this.readStartupLockHolder();
    return (
      current.present &&
      (current.livePid === undefined ||
        waitedOnHolder.livePid === undefined ||
        this.isSameStartupLockHolder(current, waitedOnHolder))
    );
  }

  /**
   * Wait for whichever live process currently holds the startup lock to publish a
   * connectable socket, re-arbitrating across *replacement* holders under ONE
   * deadline (issue #5904).
   *
   * This is the waiting core shared with {@link startByAwaitingLockHolder}: a single
   * liveness-gated {@link waitForReady} keeps the full budget while a live holder is
   * bringing the daemon up, but the moment that holder is gone this re-reads the
   * lock — and if a *different* live holder (by owner token, so PID reuse and
   * same-process sibling instances don't read as "the same holder") reclaimed it,
   * waits on that replacement under the remaining budget instead of giving up. It
   * returns false only once no live holder remains, so the caller can deliver its
   * actionable error rather than racing the client's ~30s `tools/list` deadline.
   *
   * Unlike `startByAwaitingLockHolder` it never takes over the lock itself — it is
   * for callers (e.g. `DaemonMcpProxy.startDaemon`'s "reports running but socket not
   * yet published" branch, #5664) that only wait for a holder to finish publishing.
   */
  async waitForLockHolderReadiness(timeoutMs: number): Promise<boolean> {
    const deadline = this.timer.now() + timeoutMs;
    let waitedOnHolder = this.readStartupLockHolder();

    while (this.remainingTime(deadline) > 0) {
      const ready = await this.waitForReady(
        this.remainingTime(deadline),
        undefined,
        () => this.isStillWaitingOnStartupLockHolder(waitedOnHolder),
        LOCK_HOLDER_PROBE_TIMEOUT_MS,
      );
      if (ready) {
        return true;
      }

      // The holder we waited on is gone. Re-arbitrate: if a genuinely different live
      // holder reclaimed the lock (A crashed, B took over between the predicate's
      // lock read and its liveness check), wait on B under the remaining budget; a
      // stuck same holder or a now-dead lock ends the wait.
      const current = this.readStartupLockHolder();
      if (current.livePid === undefined || this.isSameStartupLockHolder(current, waitedOnHolder)) {
        break;
      }
      waitedOnHolder = current;
    }

    // A holder can publish its socket and release its lock in the window between a
    // poll's socket check and its liveness check — and the liveness watchdog widens
    // that window, since it aborts a slow-but-healthy in-flight probe the instant
    // the lock is released rather than letting that probe complete. Confirm
    // reachability directly before reporting failure, exactly as
    // startByAwaitingLockHolder does: a bounded, NON-destructive probe that never
    // unlinks a socket, so a healthy-but-slow daemon that just came up is reported
    // ready instead of failed (issue #5904). Cap it to whatever time is left so it
    // cannot push total elapsed past the client deadline (issue #5878).
    const confirmBudget = Math.min(ABANDONED_WAIT_CONFIRM_TIMEOUT_MS, this.remainingTime(deadline));
    if (
      confirmBudget > 0 &&
      existsSync(this.socketPath) &&
      (await this.verifyDaemonConnection(confirmBudget))
    ) {
      return true;
    }
    return false;
  }

  private async getLockHolderStartupLogPath(): Promise<string | null> {
    try {
      const lockContents = await readFile(this.lockFilePath, "utf-8");
      const { pid: lockHolderPid, metadata } = parseLockContent(lockContents.trim());
      if (!Number.isSafeInteger(lockHolderPid) || lockHolderPid <= 0) {
        return null;
      }
      if (!metadata) {
        return null;
      }
      const logPath = Buffer.from(metadata, "base64url").toString("utf8");
      if (!isAbsolute(logPath) || basename(logPath) !== `daemon-launch-${lockHolderPid}.log`) {
        return null;
      }
      return logPath;
    } catch (error) {
      logger.debug(
        `[DaemonManager] Unable to read startup lock holder diagnostics: ${this.describeError(error)}`,
      );
      return null;
    }
  }

  private daemonLaunchLogPath(): string {
    return join(resolveAutoMobileLogsDir(), `daemon-launch-${process.pid}.log`);
  }

  private async createDaemonExitFailure(
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

  private describeError(error: unknown): string {
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
      logger.warn(`Error reading PID file: ${errorMessage(error)}`);
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
      Object.entries(options).filter(([, value]) => value !== undefined),
    ) as DaemonOptions;
    const restartOptions: DaemonOptions = { ...runningOptions, ...requestedOptions };
    // All restart cleanup follows the same 10s graceful + 1s forced-stop
    // budget. Run the PID-recorded daemon and every cross-namespace candidate
    // concurrently so the launcher timeout remains bounded by one cleanup window.
    await this.awaitRestartCleanup([
      () => (status.running ? this.stop() : undefined),
      () => this.stopUnrecordedDaemonsForExplicitRestart(status.pid),
    ]);
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
    const candidates = this.findLiveDaemonProcesses().filter((pid) => pid !== recordedPid);
    if (candidates.length === 0) {
      return;
    }

    stderrLog(
      `Explicit restart force-stopping ${candidates.length} live AutoMobile daemon candidate(s) without this namespace's PID record...`,
    );
    await this.awaitRestartCleanup(
      candidates.map((pid) => () => this.stopUnrecordedDaemonProcess(pid)),
    );
  }

  private async awaitRestartCleanup(
    operations: ReadonlyArray<() => void | Promise<void>>,
  ): Promise<void> {
    const results = await Promise.allSettled(
      operations.map((operation) => Promise.resolve().then(operation)),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
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
        `Failed to stop verified daemon process ${pid}: ${this.describeError(error)}`,
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
        `Failed to force-stop verified daemon process ${pid}: ${this.describeError(error)}`,
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
  async waitForReady(
    timeout: number,
    signal?: AbortSignal,
    // Defaults to "always keep waiting" so the common no-predicate call stays
    // synchronous through to the poll sleep (a caller that inspects pending timers
    // right after invocation relies on that); a predicate is consulted each poll.
    shouldContinueWaiting: () => boolean = () => true,
    maxProbeDurationMs?: number,
  ): Promise<boolean> {
    const startTime = this.timer.now();
    const deadline = startTime + timeout;
    const pollInterval = 100; // Poll every 100ms
    let pollCount = 0;
    let socketObserved = false;

    while (this.timer.now() < deadline) {
      if (signal?.aborted) {
        return false;
      }
      pollCount++;
      // Evaluated before the socket probe so a probe against a stale/stalling
      // socket cannot be handed the full remaining budget while the thing we are
      // waiting on is already gone. Readiness still wins (the probe runs first),
      // but when the holder is gone the probe is capped so it merely confirms an
      // already-connectable daemon rather than absorbing the client's deadline
      // (issue #5878).
      const keepWaiting = shouldContinueWaiting();
      if (existsSync(this.socketPath)) {
        socketObserved = true;
        const outcome = await this.probeObservedSocketWithWatchdog(
          keepWaiting,
          deadline,
          signal,
          shouldContinueWaiting,
          maxProbeDurationMs,
        );
        if (outcome === "ready") {
          stderrLog(
            `Daemon readiness probe succeeded after ${this.timer.now() - startTime}ms ` +
              `(${pollCount} polls; socket observed)`,
          );
          return true;
        }
        // A probe abort is either the caller's own cancellation or the liveness
        // watchdog firing because the holder died mid-probe (issue #5904); both end
        // the wait, and reporting not-ready lets the caller deliver its actionable
        // error rather than racing the client's ~30s deadline.
        if (outcome === "aborted") {
          stderrLog(
            `Daemon readiness probe aborted after ${this.timer.now() - startTime}ms ` +
              `(${pollCount} polls); no longer waiting on the process bringing up the daemon`,
          );
          return false;
        }
      }

      // Give up early when the caller's precondition for waiting no longer holds —
      // e.g. the process that was bringing up the daemon has died. Readiness is
      // checked first (a daemon that just became reachable wins), so this only
      // short-circuits a wait that would otherwise run the full budget with nothing
      // left to become ready, producing the caller's actionable error only as the
      // client's request times out (issue #5878).
      if (!keepWaiting) {
        stderrLog(
          `Daemon readiness wait abandoned after ${this.timer.now() - startTime}ms ` +
            `(${pollCount} polls); the process it was waiting on is no longer running`,
        );
        return false;
      }

      const remainingPollTimeMs = this.remainingTime(deadline);
      if (remainingPollTimeMs === 0) {
        break;
      }
      await this.sleepUnlessAborted(Math.min(pollInterval, remainingPollTimeMs), signal);
    }

    stderrLog(
      `Daemon readiness probe timed out after ${this.timer.now() - startTime}ms ` +
        `(${pollCount} polls; socket ${socketObserved ? "observed" : "not observed"})`,
    );
    return false;
  }

  /**
   * Run a single observed-socket readiness probe, arming a liveness watchdog on the
   * full-budget path so it cannot outlive its holder (issue #5904).
   *
   * On the full-budget probe (holder still live at the poll boundary) a stalled
   * `connect()` would otherwise absorb the whole deadline if the holder died while
   * the per-poll precheck was blocked; the watchdog aborts the probe the instant no
   * live holder remains. The capped probe (holder already gone) is short enough to
   * never race the client's deadline, so it needs no watchdog. Only the full-budget
   * wait is authoritative enough to unlink a stale socket, so `allowSocketRemoval`
   * tracks `keepWaiting` (issue #5878).
   */
  private async probeObservedSocketWithWatchdog(
    keepWaiting: boolean,
    deadline: number,
    signal: AbortSignal | undefined,
    shouldContinueWaiting: () => boolean,
    maxProbeDurationMs: number | undefined,
  ): Promise<"ready" | "aborted" | "unready"> {
    const probeDeadline = keepWaiting
      ? Math.min(
          deadline,
          maxProbeDurationMs === undefined ? deadline : this.timer.now() + maxProbeDurationMs,
        )
      : Math.min(deadline, this.timer.now() + ABANDONED_WAIT_CONFIRM_TIMEOUT_MS);
    const watchdog = keepWaiting
      ? this.startLivenessWatchdog(signal, shouldContinueWaiting)
      : undefined;
    try {
      return await this.probeObservedSocket(
        probeDeadline,
        watchdog?.signal ?? signal,
        keepWaiting && maxProbeDurationMs === undefined,
      );
    } finally {
      watchdog?.dispose();
    }
  }

  /**
   * Probe an observed socket for readiness within a single {@link waitForReady}
   * poll. Returns `"ready"` when the daemon is connectable, `"aborted"` when the
   * caller's signal fired mid-probe, or `"unready"` otherwise. A daemon started
   * from another checkout can own this namespace's socket without writing this
   * namespace's PID record, so a successful socket connection is authoritative
   * readiness even when `status()` cannot prove ownership.
   *
   * `allowSocketRemoval` gates the stale-socket cleanup on the unready path.
   * Unlinking a socket whose daemon still reports running is only safe after an
   * authoritative full-budget probe; a probe capped to a short confirm budget can
   * fail merely because a healthy daemon was slow to accept (backlog / first accept
   * after restart), so cleaning up there would unlink a LIVE daemon's socket and
   * break every later client (issue #5878, guarded by
   * `daemonManagerReadiness.integration.test.ts` "recovers on a later retry without removing a
   * live daemon's socket"). Callers running a capped probe pass `false`.
   */
  private async probeObservedSocket(
    deadline: number,
    signal: AbortSignal | undefined,
    allowSocketRemoval: boolean,
  ): Promise<"ready" | "aborted" | "unready"> {
    if (await this.verifyDaemonConnection(this.remainingTime(deadline), signal)) {
      return "ready";
    }
    if (signal?.aborted) {
      return "aborted";
    }
    if (allowSocketRemoval) {
      const status = await this.status();
      if (status.running) {
        await this.removeInvalidSocketPath();
      }
    }
    return "unready";
  }

  /**
   * Arm a liveness watchdog for a single in-flight readiness probe (issue #5904).
   *
   * Returns an {@link AbortSignal} that fires when either the caller's own signal
   * fires or a periodic `shouldContinueWaiting()` sample reports the process being
   * waited on is gone. Racing this against the probe means a stalled `connect()`
   * against an accepts-but-never-responds socket cannot keep running for the full
   * startup budget after its holder dies — the actionable failure is delivered
   * before the client's `tools/list` deadline instead of at it. The caller MUST
   * invoke `dispose()` (in a `finally`) to clear the interval and detach the
   * forwarded-abort listener, or the watchdog interval leaks past the probe.
   */
  private startLivenessWatchdog(
    callerSignal: AbortSignal | undefined,
    shouldContinueWaiting: () => boolean,
  ): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    if (callerSignal?.aborted) {
      controller.abort();
    }
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const interval = this.timer.setInterval(() => {
      // Runs on a real timer tick, not an awaited path, so a throwing predicate here
      // would surface as an unhandled exception (today's predicate cannot throw, but
      // guard it so a future one cannot crash the process). On error, keep waiting —
      // the budget deadline still bounds the probe.
      try {
        if (!shouldContinueWaiting()) {
          controller.abort();
        }
      } catch (error) {
        logger.debug(`[DaemonManager] liveness watchdog predicate threw: ${errorMessage(error)}`);
      }
    }, LIVENESS_WATCHDOG_INTERVAL_MS);
    return {
      signal: controller.signal,
      dispose: () => {
        this.timer.clearInterval(interval);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      },
    };
  }

  private async waitForExistingDaemon(timeout: number): Promise<boolean> {
    const startTime = this.timer.now();
    const deadline = startTime + timeout;
    const pollInterval = 100;

    while (this.timer.now() < deadline) {
      if (await this.verifyDaemonConnection(this.remainingTime(deadline))) {
        return true;
      }
      const remainingPollTimeMs = this.remainingTime(deadline);
      if (remainingPollTimeMs === 0) {
        break;
      }
      await this.timer.sleep(Math.min(pollInterval, remainingPollTimeMs));
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

    return new Promise((resolve) => {
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

  private remainingTime(deadline: number): number {
    return Math.max(0, deadline - this.timer.now());
  }

  private async verifyDaemonConnection(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = this.timer.now() + timeoutMs;

    // Retry the connect probe before declaring the socket dead. A single failed
    // probe is not authoritative — a live daemon under load can transiently
    // refuse a connection. Only a socket that fails every attempt is treated as
    // stale (which then triggers removeInvalidSocketPath). This is what keeps a
    // healthy daemon's socket from being unlinked on a flaky probe, the dominant
    // cause of "devices not found after daemon start/restart".
    for (let attempt = 1; attempt <= READINESS_PROBE_MAX_ATTEMPTS; attempt++) {
      const remainingTimeoutMs = this.remainingTime(deadline);
      if (remainingTimeoutMs === 0 || signal?.aborted) {
        return false;
      }
      const client = this.createClient();
      try {
        await this.connectReadinessProbe(client, remainingTimeoutMs, signal);
        return true;
      } catch (error) {
        logger.debug(
          `Daemon socket readiness probe failed (attempt ${attempt}/${READINESS_PROBE_MAX_ATTEMPTS}): ${errorMessage(error)}`,
        );
      } finally {
        try {
          await client.close();
        } catch (error) {
          logger.debug(`Failed to close daemon readiness probe client: ${errorMessage(error)}`);
        }
      }

      const remainingAfterProbeMs = this.remainingTime(deadline);
      if (attempt < READINESS_PROBE_MAX_ATTEMPTS && remainingAfterProbeMs > 0) {
        await this.sleepUnlessAborted(
          Math.min(READINESS_PROBE_BACKOFF_MS, remainingAfterProbeMs),
          signal,
        );
      }
    }

    return false;
  }

  private async connectReadinessProbe(
    client: DaemonClientLike,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const probeAbort = new AbortController();
    const forwardAbort = () => probeAbort.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    let timeout: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        client.connect(timeoutMs, probeAbort.signal),
        new Promise<never>((_, reject) => {
          timeout = this.timer.setTimeout(() => {
            probeAbort.abort();
            reject(new Error(`Daemon readiness probe timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      probeAbort.abort();
      signal?.removeEventListener("abort", forwardAbort);
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
    }
  }

  private async isLaunchedProcessReady(
    pid: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (pid === undefined) {
      return false;
    }

    const status = await this.status();
    return (
      status.running === true &&
      status.pid === pid &&
      (await this.verifyDaemonConnection(timeoutMs, signal))
    );
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
      logger.debug(`Failed to remove invalid daemon socket path: ${errorMessage(error)}`);
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
      const pidFileContent = require("fs").readFileSync(this.pidFilePath, "utf-8");
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

export function parseDaemonArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): DaemonOptions {
  const options: DaemonOptions = shouldSkipCtrlProxyDownload(args, env)
    ? { skipCtrlProxyDownload: true }
    : {};
  options.toolOutputsDir = parseToolOutputsDirConfig(
    [],
    env,
    resolveDaemonLaunchWorkingDirectory(),
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
    } else if (args[i] === "--enable-tool") {
      const toolName = args[i + 1];
      if (toolName && !toolName.startsWith("--")) {
        options.enabledTools = [...(options.enabledTools ?? []), toolName];
        i++;
      }
    } else if (args[i] === "--disable-tool") {
      const toolName = args[i + 1];
      if (toolName && !toolName.startsWith("--")) {
        options.disabledTools = [...(options.disabledTools ?? []), toolName];
        i++;
      }
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
    } else if (args[i] === "--accessibility-level" || args[i] === "--a11y-level") {
      options.accessibilityLevel = args[i + 1];
      i++;
    } else if (args[i] === "--accessibility-failure-mode" || args[i] === "--a11y-failure-mode") {
      options.accessibilityFailureMode = args[i + 1];
      i++;
    } else if (args[i] === "--accessibility-min-severity" || args[i] === "--a11y-min-severity") {
      options.accessibilityMinSeverity = args[i + 1];
      i++;
    } else if (args[i] === "--accessibility-use-baseline" || args[i] === "--a11y-use-baseline") {
      options.accessibilityUseBaseline = true;
    } else if (args[i] === "--predictive-ui" || args[i] === "--predictive") {
      options.predictiveUi = true;
    } else if (args[i] === "--raw-element-search") {
      options.rawElementSearch = true;
    } else if (
      args[i] === "--skip-ctrl-proxy-download" ||
      args[i] === "--skip-accessibility-download"
    ) {
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
  client: BuildIdentity,
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
      "\nRestart the daemon from this checkout (run `--daemon restart` with this same CLI) to align them.",
    );
  }

  return lines;
}

export async function runDaemonCommand(
  command: string,
  args: string[],
  options: RunDaemonCommandOptions = {},
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
            `  Started: ${status.startedAt ? new Date(status.startedAt).toISOString() : "unknown"}`,
          );
          for (const line of daemonBuildIdentityStatusLines(status, getCurrentBuildIdentity())) {
            console.log(line);
          }

          // Check for other daemon processes (exclude current daemon)
          const otherDaemons = manager.findOtherDaemonProcesses(status.pid);
          if (otherDaemons.length > 0) {
            console.log(
              `\n⚠️  WARNING: Found ${otherDaemons.length} other daemon process(es) from other worktrees:`,
            );
            for (const pid of otherDaemons) {
              console.log(`  - PID ${pid}`);
            }
            console.log(
              `\nThese can cause device pool conflicts. Run 'bunx ${resolveDaemonInstallSpecifier()} --daemon restart' to stop them.`,
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
        ) =>
          JSON.stringify({
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
          console.log(
            formatPoolStats(
              pool.getStats(),
              pool.getRecoveryPolicy(),
              pool.getAllDevices().map((device) => ({
                deviceId: device.id,
                platform: device.platform,
                recoveryEligibility: pool.getRecoveryEligibility(device.id),
              })),
            ),
          );
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
              console.log(
                formatPoolStats(
                  data?.poolStatus,
                  data?.poolStatus?.recoveryPolicy,
                  data?.devices?.map(
                    (device: {
                      deviceId: string;
                      platform: string;
                      recoveryEligibility?: unknown;
                    }) => ({
                      deviceId: device.deviceId,
                      platform: device.platform,
                      recoveryEligibility: device.recoveryEligibility,
                    }),
                  ),
                ),
              );
            }
            await client.close();
          } catch (error) {
            throw new ActionableError(`Failed to query available devices: ${errorMessage(error)}`);
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
          console.log(
            JSON.stringify({
              sessionId: session.sessionId,
              assignedDevice: session.assignedDevice,
              createdAt: session.createdAt,
              lastUsedAt: session.lastUsedAt,
              expiresAt: session.expiresAt,
              cacheSize: JSON.stringify(session.cacheData).length,
            }),
          );
        } else {
          // Running from CLI - query daemon via socket
          const client = manager.createClient();
          try {
            await client.connect();
            const result = await client.callDaemonMethod("daemon/sessionInfo", { sessionId });
            console.log(JSON.stringify(result));
            await client.close();
          } catch (error) {
            throw new ActionableError(`Failed to get session info: ${errorMessage(error)}`);
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
            throw new ActionableError(`Failed to release session: ${errorMessage(error)}`);
          }
        }
        break;
      }

      case "heartbeat": {
        if (args.length === 0) {
          throw new ActionableError("heartbeat requires a session ID argument");
        }
        const sessionId = args[0];
        const daemonState = manager.getDaemonState();
        if (daemonState.isInitialized()) {
          const sessionManager = daemonState.getSessionManager();
          if (!sessionManager.getSession(sessionId)) {
            throw new ActionableError(`Session not found: ${sessionId}`);
          }
          sessionManager.recordHeartbeat(sessionId);
        } else {
          const client = manager.createClient();
          try {
            await client.connect();
            await client.callDaemonMethod("daemon/heartbeat", { sessionId });
          } catch (error) {
            throw new ActionableError(`Failed to record session heartbeat: ${errorMessage(error)}`);
          } finally {
            await client.close();
          }
        }
        console.log(`Session ${sessionId} heartbeat recorded`);
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
        console.log("  heartbeat <id>        Record a heartbeat for a session");
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof ActionableError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
}
