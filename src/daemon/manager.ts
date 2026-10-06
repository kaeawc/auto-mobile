import {
  isCompleteRecoveryRecord,
  recoveryOwnerSchema,
  republishResultSchema,
  type IdentityRecoveryIO,
} from "./identityRecovery";
import { errorMessage } from "../utils/describeUnknownError";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { open, readFile, rm } from "node:fs/promises";
import {
  constants,
  existsSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { devNull, tmpdir } from "node:os";
import { isStructuredLoggingEnabled, logger, resolveAutomobileLogSink } from "../utils/logger";
import { resolveDaemonInstallSpecifier } from "../constants/release";
import {
  INCOMPLETE_EXTRACTION_CODE,
  INCOMPLETE_EXTRACTION_EXIT_CODE,
} from "../db/migrationDependencyIntegrity";
import {
  assertUnitTestLogsDirIsolated,
  ensureSecureLogsDirSync,
  resolveAutoMobileLogsDir,
} from "../utils/tempDir";
import { outputReductionFlagsToArgs } from "../utils/outputReductionFlags";
import { EVENT_ALL_MARKERS_FLAG } from "../utils/eventAllMarkers";
import { ActionableError } from "../models";
import {
  PID_FILE_PATH,
  SOCKET_PATH,
  DEFAULT_PID_FILE_PATH,
  DEFAULT_SOCKET_PATH,
  LOCK_FILE_PATH,
  DAEMON_LAUNCH_LOG_PATH_ENV,
  DAEMON_STARTUP_TIMEOUT_MS,
  DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  DAEMON_FORCED_STOP_TIMEOUT_MS,
  DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
  DAEMON_START_PROCESS_TABLE_SCAN_MAX_ATTEMPTS,
  DAEMON_START_PROCESS_TABLE_SCAN_RETRY_DELAYS_MS,
  DAEMON_RESTART_HANDOFF_DELAY_MS,
  READINESS_PROBE_MAX_ATTEMPTS,
  READINESS_PROBE_BACKOFF_MS,
  DEFAULT_DAEMON_PORT,
  DAEMON_VERSION,
  DAEMON_VERSION_RESTART_COOLDOWN_MS,
} from "./constants";
import { DaemonStatus, PidFileData, DaemonOptions } from "./types";
import {
  DaemonClient,
  type DaemonClientFactory,
  type DaemonClientFactoryOptions,
  type DaemonClientLike,
} from "./client";
import {
  DAEMON_REPUBLISH_IDENTITY_METHOD,
  DAEMON_PREPARE_MAINTENANCE_METHOD,
  DAEMON_COMPLETE_MAINTENANCE_METHOD,
  DAEMON_PREPARE_RESTART_METHOD,
  DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD,
  DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD,
  DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
  DAEMON_RESTART_ADMITTED_METHOD,
  type AcceptanceSessionRestartScope,
  type DaemonAcceptanceRestartCommit,
  type DaemonAcceptanceSessionRestart,
  DaemonRestartDeferredError,
  type DaemonAdmittedRestart,
  type DaemonRestartPreparation,
} from "./daemonRestartAdmission";
import {
  createDaemonLiveAcceptanceScopedCapability,
  daemonGenerationIdentityFromStatus,
  daemonLiveAcceptanceStartupSecret,
} from "./liveAcceptanceCapability";
import type { DaemonGenerationIdentity } from "./liveAcceptanceCapability";
import {
  DaemonSocketReachability,
  type DaemonSocketReachabilityLike,
} from "./daemonSocketReachability";
import { DaemonState, type DaemonStateLike } from "./daemonState";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { sequenceBackoff } from "../utils/Backoff";
import { DefaultRetryExecutor, type RetryExecutor } from "../utils/retry/RetryExecutor";
import {
  cleanupDaemonFiles,
  clearDaemonLaunchLogOwnerTombstoneSync,
  isConfirmedRecycledProcess,
  readPidFileDataSync,
  shouldProtectLiveDaemonVersion,
} from "./daemonFiles";
import { recordProvesFormerSocketOwner } from "./incumbentOwnerGuard";
import {
  formatLockContent,
  parseLockContent,
  releaseExclusiveLock,
  tryAcquireExclusiveLock,
} from "../utils/fileLock";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import {
  DAEMON_LAUNCH_CWD_ENV,
  resolveDaemonLaunchWorkingDirectory,
  resolvePathFromDaemonLaunchWorkingDirectory,
  resolveStableDaemonWorkingDirectory,
} from "../utils/workingDirectory";
import { TOOL_OUTPUTS_DIR_ENV } from "../utils/toolOutputArtifacts";
import {
  DaemonLauncher,
  type DaemonLaunchCommand,
  type DaemonLaunchedProcess,
  type DaemonProcessSpawner,
} from "./DaemonLauncher";
import { RUNNER_READINESS_TIMEOUT_FLAG } from "../utils/runnerReadinessConfig";
import { daemonProcessEnvironment, daemonProcessOptions } from "./daemonOptionScopes";
import {
  createDefaultDaemonProcessFinder,
  isShellCommandWrapper,
  DAEMON_SOCKET_PATH_FLAG,
  parseDaemonSocketPath,
  type DaemonProcessFinder,
  type DaemonProcessLivenessChecker,
  type DaemonProcessRecord,
  type DaemonProcessSignaler,
} from "./processTable";
import {
  NetDaemonPortAvailabilityChecker,
  type DaemonPortAvailabilityChecker,
} from "./portAvailability";
import {
  runDaemonCommand as runDaemonCommandWithManager,
  type RunDaemonCommandOptions,
} from "./cli/runDaemonCommand";

export type { DaemonLaunchCommand, DaemonProcessSpawner } from "./DaemonLauncher";
export {
  DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
  PsDaemonProcessFinder,
  WindowsDaemonProcessFinder,
  createDefaultDaemonProcessFinder,
  parseBusyBoxDaemonProcessTable,
  parseDaemonProcessTable,
  parseDarwinDaemonProcessTable,
  parseWindowsDaemonProcessTable,
} from "./processTable";
export type {
  DaemonProcessFinder,
  DaemonProcessLivenessChecker,
  DaemonProcessRecord,
  DaemonProcessSignaler,
} from "./processTable";
export { NetDaemonPortAvailabilityChecker } from "./portAvailability";
export type { DaemonPortAvailabilityChecker, ProbeListener } from "./portAvailability";
export { parseDaemonArgs } from "./cli/daemonArgs";
export {
  daemonBuildIdentityStatusLines,
  daemonCommandOptions,
  parseAcceptanceSessionRestartScope,
  parseDaemonHeartbeatCommandArgs,
  parseRestartAdmittedMaintenanceToken,
} from "./cli/runDaemonCommand";
export type { DaemonHeartbeatCommandArgs, RunDaemonCommandOptions } from "./cli/runDaemonCommand";

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

class DaemonGenerationExitedBeforeSignalError extends Error {}

interface WaitForStopResult {
  stopped: boolean;
  replacedByOtherGeneration: boolean;
}

/**
 * Process tables expose only second-granularity birth data on some supported
 * platforms. Keep a small allowance for that representation, but compare both
 * directions: an older process is not interchangeable with this generation.
 */
const DAEMON_PROCESS_BIRTH_IDENTITY_TOLERANCE_MS = 2_000;

const defaultDaemonProcessSignaler: DaemonProcessSignaler = {
  signal(pid, signal): void {
    process.kill(pid, signal);
  },
};

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

/** Host a daemon binds when `--host` is not given; mirrors the CLI default. */
const DEFAULT_DAEMON_HOST = "127.0.0.1";

/**
 * Loopback addresses the degraded start scan probes in addition to the
 * configured host (issue #7001): a port bound on one is invisible from the other,
 * so an incumbent on the default 127.0.0.1 must still be found by a `::1` start.
 */
const DEGRADED_START_PROBE_LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

interface DaemonStartProbeTarget {
  host: string;
  port: number;
}

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
 * Poll cadence while rejoining a peer daemon that is coming up on the shared
 * socket after our own spawned subprocess exited before becoming ready (issue
 * #6103). Matched to the existing reachability poll interval so a peer that
 * publishes the socket a beat after our child died is picked up within one poll,
 * without hammering the process table between socket probes.
 */
const PEER_DAEMON_JOIN_POLL_MS = 100;

/**
 * How often the post-exit peer rejoin (issue #6103) re-runs the SYNCHRONOUS process-
 * table scan that establishes "a live peer daemon is coming up". The scan
 * (`ps`/PowerShell/CIM via {@link findLiveDaemonProcesses}) blocks the event loop, so
 * running it every {@link PEER_DAEMON_JOIN_POLL_MS} poll would stall the loop for the
 * whole budget. The per-iteration signal is the cheap socket connect probe; the
 * process table is scanned once up front and then only at this coarser cadence, purely
 * so a peer that DIES mid-wait still ends the loop rather than polling out the budget.
 */
const PEER_DAEMON_PROCESS_SCAN_INTERVAL_MS = 1000;

/**
 * Delivery headroom reserved under the client's original start deadline before the
 * post-exit peer rejoin (issue #6103) may run. The rejoin is nested inside a
 * `tools/list` the client times out at DAEMON_STARTUP_TIMEOUT_MS; if the rejoin were
 * allowed to consume every last millisecond, the actionable diagnostic it rethrows on
 * failure would land AT the deadline instead of before it (issue #5878/#5904). Skipping
 * the rejoin once less than this remains guarantees time to format and deliver that
 * error. A near-deadline exit therefore fails fast rather than spending its final
 * moments on a rejoin that cannot report its own failure in time.
 */
const PEER_DAEMON_JOIN_DELIVERY_HEADROOM_MS = 2000;

/**
 * Short readiness grace for an isolated namespace after our child exits. Only
 * positively attributed namespace peers qualify; keep the existing bounded
 * isolated-launch handoff budget rather than extending failed-start latency.
 */
const PEER_DAEMON_ISOLATED_NAMESPACE_GRACE_MS = 2000;

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
 * Bound on `stop()`'s attempt to acquire the namespace startup lock before
 * removing a confirmed-dead PID file (issue #6140). Coordinates PID-file
 * deletion with a concurrent daemon start, which holds the SAME lock while
 * binding and publishing its own record — closing the window where a
 * concurrent start rewrites the PID file between `stop()`'s liveness check and
 * its unlink. Bounded so `stop()` can never hang if a start holds the lock
 * unusually long; on timeout the stale PID record is left for a later explicit
 * cleanup or startup to supersede safely (see {@link DaemonManager.removeConfirmedDeadPidFile}).
 */
const PID_FILE_DELETE_LOCK_ACQUIRE_TIMEOUT_MS = 2000;

/** Poll interval while retrying {@link PID_FILE_DELETE_LOCK_ACQUIRE_TIMEOUT_MS}. */
const PID_FILE_DELETE_LOCK_POLL_MS = 50;

/**
 * A snapshot of the daemon startup lock's current holder, as read from the lock
 * file. `token` carries the holder's per-instance owner token (issue #5904) so a
 * replacement holder is distinguishable from the prior one even under PID reuse.
 */
interface StartupLockHolder {
  metadataPending?: boolean;
  recovering?: boolean;
  present: boolean;
  livePid: number | undefined;
  token: string | undefined;
}

export type DaemonStartResult = "started" | "joined" | "replaced";

function restartResultFromStart(result: DaemonStartResult): DaemonRestartResult {
  return result === "joined" ? "joined" : "restarted";
}

function mergeRestartOptions(running: DaemonOptions, requested: DaemonOptions): DaemonOptions {
  const merged = { ...running, ...requested, strictPort: true };
  if (
    requested.enabledTools !== undefined &&
    requested.disabledTools === undefined &&
    running.disabledTools !== undefined
  ) {
    merged.disabledTools = running.disabledTools.filter(
      (name) => !requested.enabledTools?.includes(name),
    );
  }
  if (
    requested.disabledTools !== undefined &&
    requested.enabledTools === undefined &&
    running.enabledTools !== undefined
  ) {
    merged.enabledTools = running.enabledTools.filter(
      (name) => !requested.disabledTools?.includes(name),
    );
  }
  return merged;
}

/**
 * Surface of DaemonManager used by clients (e.g. DaemonMcpProxy).
 * Allows injecting fakes in tests without subclassing the concrete class.
 */
export interface DaemonManagerLike {
  status(): Promise<DaemonStatus>;
  start(options?: DaemonOptions): Promise<DaemonStartResult>;
  /**
   * Recover a control socket that has already failed health/protocol checks.
   * The manager owns the lifecycle lock while it rechecks the socket owner and,
   * only when that check remains unhealthy, escalates to verified daemon-mode
   * process cleanup and a strict-port replacement.
   */
  recoverControlState(
    options?: DaemonOptions,
    isProtocolHealthy?: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<DaemonRestartResult>;
  /**
   * When `expectedDaemon` is supplied, restart only that verified generation.
   * A changed generation means another client already completed the handoff.
   */
  restart(options?: DaemonOptions, expectedDaemon?: DaemonStatus): Promise<DaemonRestartResult>;
  restartAdmitted(options: DaemonOptions, maintenanceToken: string): Promise<DaemonRestartResult>;
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
 * The outcome of a daemon restart attempt.
 *
 * A conditional restart can join a successor selected by another client instead
 * of replacing it. Callers must re-read that successor before declaring their
 * startup options incompatible.
 */
export type DaemonRestartResult = "restarted" | "joined";

const DAEMON_ADMITTED_RESTART_REASONS: ReadonlySet<string> = new Set([
  "active_operations",
  "active_sessions",
  "generation_changed",
  "maintenance_token_invalid",
  "maintenance_token_consumed",
  "restart_pending",
  "shutdown_unavailable",
  "sessions_unavailable",
]);

function isDaemonAdmittedRestartReason(
  value: unknown,
): value is NonNullable<DaemonAdmittedRestart["reason"]> {
  return typeof value === "string" && DAEMON_ADMITTED_RESTART_REASONS.has(value);
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
  private identityRecoveryInFlight?: Promise<DaemonStatus>;
  private recoveryOwner?: DaemonStatus;
  private readonly identityRecoveryIO: IdentityRecoveryIO;
  private readonly clientFactory: DaemonClientFactory;
  private readonly stateProvider: () => DaemonStateLike;
  private readonly timer: Timer;
  private readonly lockFilePath: string;
  private readonly pidFilePath: string;
  private readonly socketPath: string;
  private readonly processFinder: DaemonProcessFinder;
  private readonly processLivenessChecker: DaemonProcessLivenessChecker;
  private readonly processSignaler: DaemonProcessSignaler;
  private readonly retryExecutor: RetryExecutor;
  private readonly portAvailabilityChecker: DaemonPortAvailabilityChecker;
  private readonly extractionCleaner: ExtractionCleaner;
  private readonly launcher: DaemonLauncher;
  private readonly fallbackLauncher: DaemonLauncher;
  /**
   * Observation-only reachability probe for the post-exit peer rejoin (issue #6103):
   * it never unlinks or stale-cleans the socket, and is platform-aware at the connect
   * layer. Assigned in the constructor body from the injected {@link Timer} (never a
   * field initializer, which would bind the real wall-clock even under a FakeTimer),
   * and injectable so a test can drive the probe outcome without a real socket.
   */
  private readonly peerSocketReachability: DaemonSocketReachabilityLike;
  private readonly daemonProtocolHealthProbe: () => Promise<boolean>;
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
  /**
   * Injected so a test can simulate Windows named-pipe semantics without a real
   * OS switch (issue #6140). Defaults to the real platform; a Unix domain socket
   * has a filesystem entry, but a Windows named pipe does not, so every
   * `existsSync(this.socketPath)` readiness gate must be skipped on win32 the
   * same way {@link DaemonClient.isAvailable} already is.
   */
  private readonly platform: NodeJS.Platform;

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
    peerSocketReachability: DaemonSocketReachabilityLike | undefined = undefined,
    platformOverride: NodeJS.Platform = process.platform,
    portAvailabilityChecker: DaemonPortAvailabilityChecker = new NetDaemonPortAvailabilityChecker(),
    retryExecutor: RetryExecutor = new DefaultRetryExecutor(timer),
    daemonProtocolHealthProbe: (() => Promise<boolean>) | undefined = undefined,
    identityRecoveryIO?: IdentityRecoveryIO,
  ) {
    this.identityRecoveryIO = identityRecoveryIO ?? {
      // Windows named pipes cannot use this POSIX socket identity probe. This accepted
      // platform gap means a live Windows daemon with missing PID metadata will not
      // self-heal here; retain the pre-identity-recovery behavior on Windows.
      // On win32, namespace attribution uses only the argv socket marker or our PID
      // record; the default IO never probes a socket owner.
      socketExists: () => this.platform !== "win32" && existsSync(this.socketPath),
      readRecord: () => readPidFileDataSync(this.pidFilePath),
      probe: () =>
        this.platform === "win32"
          ? Promise.reject(
              new Error(
                "Failed to connect to daemon: socket-owner probing is unsupported on win32",
              ),
            )
          : new DaemonClient(this.socketPath, 1000, this.timer).getDaemonStatus(1000),
    };
    this.platform = platformOverride;
    this.portAvailabilityChecker = portAvailabilityChecker;
    this.retryExecutor = retryExecutor;
    this.startupLockOwnerToken = idGenerator.next();
    // Construct the reachability probe here (not in a field initializer) so its connect
    // timeout is bound to the injected timer — a field initializer would capture the
    // real wall-clock even when this manager runs under a FakeTimer (issue #6103).
    this.peerSocketReachability = peerSocketReachability ?? new DaemonSocketReachability({ timer });
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
      clientFactory ??
      ((options) =>
        new DaemonClient(this.socketPath, undefined, timer, {}, options?.clientIdentity));
    this.daemonProtocolHealthProbe =
      daemonProtocolHealthProbe ??
      (async () => {
        try {
          await new DaemonClient(this.socketPath, undefined, this.timer).getDaemonStatus();
          return true;
        } catch (error) {
          // A failed status probe is the explicit repair precondition, not a
          // lifecycle failure in its own right.
          logger.debug(`Daemon control-state protocol probe failed: ${errorMessage(error)}`);
          return false;
        }
      });
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

  createClient(options?: DaemonClientFactoryOptions): DaemonClientLike {
    return this.clientFactory(options);
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
  findAllDaemonProcesses(timeoutMs?: number): number[] {
    try {
      return this.normalizeDaemonProcessRecords(this.processFinder.findDaemonProcesses(timeoutMs));
    } catch (error) {
      throw new ActionableError(`Failed to inspect daemon process table: ${errorMessage(error)}`);
    }
  }

  findOtherDaemonProcesses(activeDaemonPid: number | undefined): number[] {
    return this.findLiveDaemonProcessRecords()
      .filter((candidate) => this.hasNamespaceRecordOrMarker(candidate))
      .map((candidate) => candidate.pid)
      .filter((pid) => pid !== activeDaemonPid);
  }

  /**
   * @param timeoutMs Bounds the underlying process-table scan for a caller with a
   * tight remaining budget (issue #6140); see {@link DaemonProcessFinder.findDaemonProcesses}.
   */
  findLiveDaemonProcesses(timeoutMs?: number): number[] {
    return this.findAllDaemonProcesses(timeoutMs).filter((pid) => this.isProcessRunning(pid));
  }

  private findLiveDaemonProcessRecords(timeoutMs?: number): DaemonProcessRecord[] {
    try {
      const records = this.processFinder.findDaemonProcesses(timeoutMs);
      const daemonPids = new Set(this.normalizeDaemonProcessRecords(records));
      return records
        .filter((record) => daemonPids.has(record.pid) && this.isProcessRunning(record.pid))
        .map((record) => ({ ...record, socketPath: parseDaemonSocketPath(record.command) }));
    } catch (error) {
      throw new ActionableError(`Failed to inspect daemon process table: ${errorMessage(error)}`);
    }
  }

  private hasNamespaceRecordOrMarker(candidate: DaemonProcessRecord): boolean {
    if (candidate.socketPath !== undefined) {
      return candidate.socketPath === this.socketPath;
    }
    // An invalid marker is not an unmarked legacy launch.
    if (candidate.command.includes(DAEMON_SOCKET_PATH_FLAG)) {
      return false;
    }
    const record = this.recordedStatus();
    return (
      record.running &&
      record.pid === candidate.pid &&
      this.matchesRecordedDaemonGeneration(record, candidate)
    );
  }

  private async probeNamespaceOwner(): Promise<DaemonStatus | undefined> {
    try {
      const owner = await this.identityRecoveryIO.probe();
      return owner.running &&
        owner.pid !== undefined &&
        this.isProcessRunning(owner.pid) &&
        (owner.reportedSocketPath === undefined || owner.reportedSocketPath === this.socketPath) &&
        (owner.reportedPidFilePath === undefined || owner.reportedPidFilePath === this.pidFilePath)
        ? owner
        : undefined;
    } catch (error) {
      if (
        /ECONNREFUSED|ENOENT|Daemon socket not found|Failed to connect to daemon|timed out/i.test(
          errorMessage(error),
        )
      ) {
        // An absent or busy namespace socket grants no orphan ownership evidence.
        logger.debug("No namespace socket owner available for daemon discovery", error);
      } else {
        logger.warn("Failed to probe namespace socket ownership", error);
      }
      return undefined;
    }
  }

  private async findNamespaceDaemonProcessRecords(
    timeoutMs?: number,
  ): Promise<DaemonProcessRecord[]> {
    const candidates = this.findLiveDaemonProcessRecords(timeoutMs);
    const owner =
      !this.recordedStatus().running ||
      candidates.some(
        (candidate) =>
          !this.hasNamespaceRecordOrMarker(candidate) &&
          !candidate.command.includes(DAEMON_SOCKET_PATH_FLAG),
      )
        ? await this.probeNamespaceOwner()
        : undefined;
    if (owner?.pid !== undefined && !candidates.some((candidate) => candidate.pid === owner.pid)) {
      candidates.push({
        pid: owner.pid,
        ppid: 0,
        command: "",
        startedAt: owner.processStartedAt ?? owner.startedAt,
        processGenerationToken: owner.processGenerationToken,
      });
    }
    return candidates.filter((candidate) => {
      const ours =
        this.hasNamespaceRecordOrMarker(candidate) ||
        (!candidate.command.includes(DAEMON_SOCKET_PATH_FLAG) && owner?.pid === candidate.pid);
      if (!ours) {
        logger.debug(`Ignoring daemon PID ${candidate.pid}: no evidence for this socket namespace`);
      }
      return ours;
    });
  }

  /**
   * Startup can still determine socket ownership through the PID/lock/readiness
   * path when a loaded host times out while listing processes. A successful port
   * probe forces strict-port launch because it closes its probe socket before the
   * child binds; the child's own bind is the authoritative guard. Keep that narrowly
   * scoped degradation out of the fail-closed lifecycle scans used elsewhere.
   */
  private async findLiveDaemonProcessesForStart(
    options: DaemonOptions,
    startDeadline: number,
  ): Promise<number[]> {
    const scanBudget = this.remainingTime(startDeadline);
    if (scanBudget <= 0) {
      throw new ActionableError(
        "Daemon startup deadline elapsed before process-table inspection could complete; refusing to launch a daemon after the client deadline.",
      );
    }

    // RetryExecutor already owns the retry/backoff policy. Limit each scan and
    // each one of its existing sequence-backoff delays to time still available
    // under this start request rather than beginning an independent timeout window.
    const scanBackoff = sequenceBackoff(DAEMON_START_PROCESS_TABLE_SCAN_RETRY_DELAYS_MS);
    const result = await this.retryExecutor.execute(
      async () => {
        const remaining = this.remainingTime(startDeadline);
        if (remaining <= 0) {
          throw new Error("Process-table inspection ETIMEDOUT before daemon startup deadline");
        }
        return (
          await this.findNamespaceDaemonProcessRecords(
            Math.min(DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS, remaining),
          )
        ).map((candidate) => candidate.pid);
      },
      {
        maxAttempts: DAEMON_START_PROCESS_TABLE_SCAN_MAX_ATTEMPTS,
        delays: (attempt) =>
          Math.min(scanBackoff.delayForAttempt(attempt), this.remainingTime(startDeadline)),
        shouldRetry: (error) =>
          error.message.includes("ETIMEDOUT") && this.remainingTime(startDeadline) > 0,
      },
    );

    if (this.remainingTime(startDeadline) <= 0) {
      throw new ActionableError(
        "Daemon startup deadline elapsed during process-table inspection; refusing to launch a daemon after the client deadline.",
      );
    }

    if (result.success) {
      return result.value ?? [];
    }

    const error = result.error ?? new Error("Process-table inspection failed without an error");
    if (!error.message.includes("ETIMEDOUT")) {
      throw error;
    }

    // Port occupancy alone cannot attribute a process to this socket namespace.
    const owner = await this.probeNamespaceOwner();
    if (owner?.pid !== undefined) {
      return [owner.pid];
    }
    const occupied = await this.findOccupiedDaemonStartPort(
      this.degradedStartProbeTargets(options),
      this.remainingTime(startDeadline),
    );
    if (occupied === undefined) {
      options.strictPort = true;
    }
    // A foreign listener can occupy the default port; allow the normal fallback
    // while the namespace lock/socket bind guard protects against duplicate owners.
    logger.warn(
      `[DaemonManager] process-table inspection timed out during daemon start; proceeding with namespace ownership checks: ${errorMessage(error)}`,
      error,
    );
    return [];
  }

  /**
   * Every (host, port) pair the degraded scan must probe: each candidate port on
   * the configured host plus the loopback alternates, configured host first so
   * the incumbent most likely to own this install's socket is reported.
   */
  private degradedStartProbeTargets(options: DaemonOptions): DaemonStartProbeTarget[] {
    const hosts = [
      ...new Set([options.host ?? DEFAULT_DAEMON_HOST, ...DEGRADED_START_PROBE_LOOPBACK_HOSTS]),
    ];
    return this.degradedStartProbePorts(options).flatMap((port) =>
      hosts.map((host) => ({ host, port })),
    );
  }

  private degradedStartProbePorts(options: DaemonOptions): number[] {
    const configuredPort = options.port ?? DEFAULT_DAEMON_PORT;
    const candidatePorts = [configuredPort];
    if (DEFAULT_DAEMON_PORT !== configuredPort) {
      candidatePorts.push(DEFAULT_DAEMON_PORT);
    }
    const persistedPort = this.readPersistedDaemonOwnerPortForStart();
    if (persistedPort !== undefined && !candidatePorts.includes(persistedPort)) {
      candidatePorts.push(persistedPort);
    }
    return candidatePorts;
  }

  private readPersistedDaemonOwnerPortForStart(): number | undefined {
    if (!existsSync(this.pidFilePath)) {
      logger.debug(
        `[DaemonManager] no persisted daemon owner record was available while widening the degraded process-table scan probe: ${this.pidFilePath}`,
      );
      return undefined;
    }
    try {
      const pidData: PidFileData = JSON.parse(readFileSync(this.pidFilePath, "utf8"));
      if (typeof pidData.port === "number") {
        return pidData.port;
      }
      logger.debug(
        `[DaemonManager] persisted daemon owner record has no usable port while widening the degraded process-table scan probe: ${this.pidFilePath}`,
      );
    } catch (pidFileError) {
      // Safe to continue: this is only a best-effort expansion of the ownership probe.
      logger.debug(
        `[DaemonManager] failed to read persisted daemon owner record while widening the degraded process-table scan probe: ${errorMessage(pidFileError)}`,
      );
    }
    return undefined;
  }

  /**
   * Probes every target concurrently, each bounded by the SAME remaining start
   * budget, so the whole set costs one probe's wall time and can never push the
   * actionable result past the client deadline (issue #7001). The first occupied
   * target in candidate order wins so the reported incumbent is deterministic.
   */
  private async findOccupiedDaemonStartPort(
    targets: DaemonStartProbeTarget[],
    budgetMs: number,
  ): Promise<DaemonStartProbeTarget | undefined> {
    const results = await Promise.all(
      targets.map((target) =>
        this.portAvailabilityChecker.isPortFree(target.port, target.host, budgetMs),
      ),
    );
    return targets.find((_, index) => !results[index]);
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
  async start(options: DaemonOptions = {}): Promise<DaemonStartResult> {
    if (!this.acquireLock()) {
      return await this.startByAwaitingLockHolder(options);
    }

    try {
      return await this.startUnlocked(options);
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
  private async startByAwaitingLockHolder(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    onTakeover?: () => Promise<DaemonStartResult>,
  ): Promise<DaemonStartResult> {
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
      this.throwIfRecoveryCancelled(recoverySignal);
      const remaining = this.remainingTime(arbitrationDeadline);
      stderrLog("Another process is starting the daemon, waiting...");
      // Capture diagnostics while the current holder still holds the lock, so they
      // survive into the failure message if the holder later releases on failure.
      holderLogPath = (await this.getLockHolderStartupLogPath()) ?? holderLogPath;
      this.throwIfRecoveryCancelled(recoverySignal);
      // Recovery is asserted by this lock holder, never inferred from an ambient socket.
      waitedOnHolder = this.readStartupLockHolder();
      const ready = await this.waitForStartupLockHolder(
        arbitrationDeadline,
        remaining,
        waitedOnHolder,
        recoverySignal,
      );
      this.throwIfRecoveryCancelled(recoverySignal);
      if (ready) {
        stderrLog("Daemon started by another process");
        return "joined";
      }

      // The holder we waited on is gone — take over its start.
      this.throwIfRecoveryCancelled(recoverySignal);
      if (this.acquireLock()) {
        stderrLog("Previous lock holder failed, taking over daemon start...");
        try {
          this.throwIfRecoveryCancelled(recoverySignal);
          return await (onTakeover?.() ?? this.startUnlocked(options, recoverySignal));
        } finally {
          this.releaseLock();
        }
      }

      // We could not take over, so the lock is still held. Keep waiting only for a
      // genuinely different live holder (a replacement that reclaimed the lock while
      // the prior one died); a stuck same holder or a now-dead lock ends the loop.
      // Identity is by owner token, not PID, so a replacement that reused the prior
      // holder's PID — OS recycling, or a same-process sibling manager instance — is
      // still recognized as a replacement rather than read as the same stuck holder
      // (issue #5904).
      this.throwIfRecoveryCancelled(recoverySignal);
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
    this.throwIfRecoveryCancelled(recoverySignal);
    if (
      await this.confirmLockFollowerReady(
        confirmBudget,
        waitedOnHolder.recovering === true,
        recoverySignal,
      )
    ) {
      this.throwIfRecoveryCancelled(recoverySignal);
      stderrLog("Daemon became ready before reporting startup failure");
      return "joined";
    }
    throw await this.createLockHolderStartupFailure(holderLogPath);
  }

  private async waitForStartupLockHolder(
    deadline: number,
    remaining: number,
    holder: StartupLockHolder,
    signal?: AbortSignal,
  ): Promise<boolean> {
    Object.assign(holder, await this.readSettledStartupLockHolder(deadline, signal));
    const stillWaiting = () => this.isStillWaitingOnStartupLockHolder(holder);
    if (!holder.recovering) {
      const ready = await this.waitForReady(
        Math.min(remaining, this.remainingTime(deadline)),
        signal,
        stillWaiting,
        LOCK_HOLDER_PROBE_TIMEOUT_MS,
      );
      // The holder may enter replacement while the ordinary readiness probe awaits.
      const current = await this.readSettledStartupLockHolder(deadline, signal);
      // Any current recovery invalidates reachability, even after ownership changes.
      // Keep the original PID/token for the outer loop's holder-change detection.
      holder.recovering = current.recovering;
      if (!holder.recovering) {
        return ready;
      }
    }
    return this.waitForPublishedLockHolderIdentity(deadline, stillWaiting, signal);
  }

  /** Retry only torn JSON; legacy metadata never consumes arbitration budget. */
  private async readSettledStartupLockHolder(
    deadline: number,
    signal?: AbortSignal,
  ): Promise<StartupLockHolder> {
    let holder = this.readStartupLockHolder();
    for (let attempt = 0; holder.metadataPending && attempt < 3; attempt++) {
      if (this.remainingTime(deadline) <= 0) {
        break;
      }
      await this.sleepUnlessAborted(Math.min(1, this.remainingTime(deadline)), signal);
      holder = this.readStartupLockHolder();
    }
    // Persistent corruption is not evidence that generic reachability is safe.
    return holder;
  }

  private async confirmLockFollowerReady(
    budget: number,
    requireIdentity: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (budget <= 0 || !this.socketPathObservable()) {
      return false;
    }
    return requireIdentity
      ? this.waitForPublishedLockHolderIdentity(this.timer.now() + budget, () => false, signal)
      : this.verifyDaemonConnection(budget);
  }

  /** A bounded observation: a stalled incumbent must not extend arbitration. */
  private async authenticateLockFollowerOwner(deadline: number): Promise<DaemonStatus> {
    const budget = Math.min(LOCK_HOLDER_PROBE_TIMEOUT_MS, this.remainingTime(deadline));
    if (budget <= 0 || !this.identityRecoveryIO.socketExists()) {
      return { running: false };
    }
    const timeout = new Error("Lock follower owner probe timed out");
    try {
      return await raceWithDeadline(this.authenticateSocketOwner(), {
        timer: this.timer,
        timeoutMs: budget,
        label: "Lock follower owner probe",
        timeoutError: () => timeout,
      });
    } catch (error) {
      if (error === timeout) {
        return { running: false };
      }
      throw error;
    }
  }

  /**
   * Reachability alone can join an incumbent that the lock holder is about to kill.
   * Require a complete record matching the observed generation: either the repaired
   * incumbent or its successor. Never grant a fresh budget when the holder changes.
   */
  private async waitForPublishedLockHolderIdentity(
    deadline: number,
    shouldContinueWaiting: () => boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    while (this.remainingTime(deadline) > 0) {
      this.throwIfRecoveryCancelled(signal);
      const owner = await this.authenticateLockFollowerOwner(deadline);
      if (owner.running && this.hasPublishedRecoveryIdentity(owner)) {
        return true;
      }
      if (!shouldContinueWaiting()) {
        return false;
      }
      await this.sleepUnlessAborted(Math.min(100, this.remainingTime(deadline)), signal);
    }
    return false;
  }

  /**
   * Internal start implementation (caller must hold lock).
   */
  private async startUnlocked(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
  ): Promise<DaemonStartResult> {
    options = daemonProcessOptions(options);
    // The overall start budget, captured before any work so the post-exit peer
    // rejoin (issue #6103) can only ever spend time the caller still has. The
    // client times its `tools/list` out at DAEMON_STARTUP_TIMEOUT_MS; launchAndWait
    // may consume all of it (plus the time spent stopping a timed-out child), so a
    // rejoin bounded by a FRESH reachability budget could push the actionable
    // diagnostic past the client deadline — the exact failure #5878/#5904 exist to
    // prevent. Bounding the rejoin by the time REMAINING under this deadline keeps
    // the error deliverable.
    const startDeadline = this.timer.now() + DAEMON_STARTUP_TIMEOUT_MS;
    let status = await this.lifecycleStatus();
    this.throwIfRecoveryCancelled(recoverySignal);
    if (
      status.running &&
      !(await this.verifyDaemonGenerationBeforeSignal(
        this.daemonProcessRecordFromStatus(status),
        undefined,
        "Daemon start",
      ))
    ) {
      status = { running: false };
    }
    if (!status.running && status.recovery) {
      const owner =
        status.recovery.state === "unauthenticated" ? await this.probeNamespaceOwner() : undefined;
      // Older socket owners lack identity-republication fields. Reuse their
      // answering namespace socket without granting permission to signal them.
      if (
        owner?.reportedSocketPath === undefined &&
        owner?.reportedPidFilePath === undefined &&
        owner?.pid !== undefined &&
        (await this.waitForExistingDaemon(
          Math.min(DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS, this.remainingTime(startDeadline)),
        ))
      ) {
        return "joined";
      }
      return this.startIdentityRecovery(status);
    }
    if (status.running) {
      // ensureVersionMatches/compareStrictNumericVersions treat empty/unparseable as older (+Infinity); this start guard deliberately protects it.
      if (shouldProtectLiveDaemonVersion(status.version, DAEMON_VERSION)) {
        stderrLog(`Daemon is already running (PID ${status.pid}, port ${status.port})`);
        return "joined";
      }
      if (status.startedAt) {
        const daemonAgeMs = this.timer.now() - status.startedAt;
        if (daemonAgeMs < DAEMON_VERSION_RESTART_COOLDOWN_MS) {
          logger.warn(
            `[DaemonManager] Skipping strictly-older daemon takeover due to cooldown: daemon ${status.version} is ${daemonAgeMs}ms old, current version is ${DAEMON_VERSION}`,
          );
          throw new DaemonRestartDeferredError("restart is in cooldown");
        }
      }

      const preparation = await this.prepareDaemonForConditionalRestart(status);
      if (!preparation.accepted) {
        if (
          preparation.reason === "generation_changed" ||
          preparation.reason === "restart_pending"
        ) {
          stderrLog("Daemon restart is already in progress; joining its successor");
          return "joined";
        }
        if (preparation.reason === "active_operations") {
          throw new DaemonRestartDeferredError("a device operation is active");
        }
        if (preparation.reason === "shutdown_unavailable") {
          throw new DaemonRestartDeferredError("the daemon could not initiate its own shutdown");
        }
        throw new DaemonRestartDeferredError(
          "the daemon returned an unrecognized safe-restart admission result",
        );
      }

      const requestedOptions = daemonProcessOptions(
        Object.fromEntries(
          Object.entries(options).filter(([, value]) => value !== undefined),
        ) as DaemonOptions,
      );
      options = {
        ...daemonProcessOptions(status.options),
        ...requestedOptions,
        strictPort: true,
      };
      stderrLog(
        `Detected strictly older AutoMobile daemon version ${status.version} (PID ${status.pid}); stopping it before upgrade...`,
      );
      await this.stopRunningDaemon(status, DAEMON_SHUTDOWN_TIMEOUT_MS, false);
      await this.assertNoSurvivingDaemonBeforeRestart(options);
      await this.timer.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
    }

    // A missing or stale PID record must not turn an ordinary start request into
    // permission to terminate a live daemon. This happens when a second client
    // reaches the shared socket during a long-running tool call and races a
    // transient availability probe. Reuse a responsive daemon; require an
    // explicit restart for a live but unreachable process.
    const liveDaemons = await this.findLiveDaemonProcessesForStart(options, startDeadline);
    this.throwIfRecoveryCancelled(recoverySignal);
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
      const existingDaemonWaitBudget = Math.min(
        DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS,
        this.remainingTime(startDeadline),
      );
      const existingDaemonReady = await this.waitForExistingDaemon(existingDaemonWaitBudget);
      this.throwIfRecoveryCancelled(recoverySignal);
      if (existingDaemonReady) {
        stderrLog("Reusing existing responsive daemon");
        return "joined";
      }

      throw new ActionableError(
        `Found live AutoMobile daemon process(es) (${liveDaemons.join(", ")}) but none became reachable within ` +
          `${existingDaemonWaitBudget}ms. Refusing to terminate a live daemon during start; ` +
          `inspect it or run \`bunx ${resolveDaemonInstallSpecifier()} --daemon restart\` explicitly.`,
      );
    }

    // Do not pre-emptively remove namespace files here. The lock serializes
    // cooperative managers, but a direct daemon may still own a socket which
    // this manager cannot prove stale. The child uses the shared bind guard to
    // reclaim only a socket with an unreachable listener and a positively-dead
    // recorded owner; it publishes its own early PID record before that bind.

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
    const childEnv = this.daemonLaunchEnvironment(options);
    const logSink = resolveAutomobileLogSink(childEnv);
    const capturesLaunchOutput = logSink !== "stderr";
    const logPath = capturesLaunchOutput
      ? (this.heldLockLogPath ?? this.daemonLaunchLogPath())
      : devNull;
    // Preserve the exact capture path for the child PID record. Retention uses
    // this association instead of letting an unrelated live daemon protect all
    // launch logs in a shared directory.
    childEnv[DAEMON_LAUNCH_LOG_PATH_ENV] = capturesLaunchOutput ? logPath : "";
    if (capturesLaunchOutput) {
      assertUnitTestLogsDirIsolated();
      ensureSecureLogsDirSync();
      // `openSync(..., "w")` below starts a new launch-log generation. A
      // same-PID manager reuse can otherwise leave a dead prior generation's
      // exact-owner sidecar behind and let pruning delete this fresh file while
      // its child still holds the descriptor.
      clearDaemonLaunchLogOwnerTombstoneSync(logPath);
    }
    // Open with restricted permissions (0o600 = owner read/write only).
    // Stderr-only containers deliberately skip the file capture and do not need
    // a writable AutoMobile data directory.
    const logFd = openSync(logPath, "w", 0o600);

    try {
      let retriedIncompleteExtraction = false;
      while (true) {
        const attemptBudget = this.remainingTime(startDeadline);
        if (attemptBudget <= 0) {
          throw new ActionableError(
            "Daemon startup deadline elapsed before launch; refusing to start a daemon after the client deadline.",
          );
        }
        try {
          this.throwIfRecoveryCancelled(recoverySignal);
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
            timeoutMs: attemptBudget,
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
            this.throwIfRecoveryCancelled(recoverySignal);
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
    } catch (error) {
      this.throwIfRecoveryCancelled(recoverySignal);
      // Our spawned subprocess failed before becoming ready. Under a concurrent
      // cold start, a PEER client's same-namespace daemon may still be publishing
      // the shared socket a beat later — our child merely lost the socket-ownership
      // race (issue #6103). Rejoin that peer within a bounded, candidate-gated wait
      // instead of surfacing our child's exit as terminal; a genuine start failure
      // (no peer coming up) still fails promptly (issue #5878).
      //
      // Bound the rejoin by the time REMAINING under the original start deadline, LESS a
      // delivery-headroom reserve, not a fresh reachability budget: if launchAndWait
      // already consumed most of the client's ~30s budget (a startup timeout, plus
      // stopping the timed-out child), skip the rejoin and rethrow now so the actionable
      // diagnostic still beats the client deadline WITH time to spare (issue #5878/#5904).
      const rejoinBudget = Math.min(
        DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS,
        this.remainingTime(startDeadline) - PEER_DAEMON_JOIN_DELIVERY_HEADROOM_MS,
      );
      if (rejoinBudget > 0 && (await this.tryJoinPeerDaemonAfterSpawnExit(rejoinBudget))) {
        stderrLog(
          "A peer daemon became ready on the shared socket after our launch exited; joining it",
        );
        return "joined";
      }
      throw error;
    } finally {
      // Close our reference to the log file (daemon process still has it open)
      closeSync(logFd);
    }

    const newStatus = await this.lifecycleStatus();
    stderrLog(`Daemon started successfully (PID ${newStatus.pid}, port ${newStatus.port})`);
    stderrLog(`Socket: ${newStatus.socketPath}`);
    stderrLog(`Logs: ${logPath}`);
    return "started";
  }

  private daemonLaunchEnvironment(options: DaemonOptions): NodeJS.ProcessEnv {
    const childEnv = daemonProcessEnvironment(process.env);
    if (this.recoveryOwner?.dbPath) {
      childEnv.AUTOMOBILE_DB_PATH = this.recoveryOwner.dbPath;
    }
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
    return childEnv;
  }

  private withDaemonOptions(
    launch: DaemonLaunchCommand,
    options: DaemonOptions,
  ): DaemonLaunchCommand {
    const args = [
      ...launch.args,
      `${DAEMON_SOCKET_PATH_FLAG}=${encodeURIComponent(this.socketPath)}`,
    ];
    if (options.port) {
      args.push("--port", options.port.toString());
    }
    if (options.host) {
      args.push("--host", options.host);
    }
    if (options.strictPort) {
      args.push("--strict-port");
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
    const { pid, token, metadata } = parseLockContent(content);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      // Unreadable PID — a holder may still be filling it in; keep waiting.
      return { present: true, livePid: undefined, token };
    }
    return this.isProcessRunning(pid)
      ? {
          present: true,
          livePid: pid,
          token,
          ...this.startupLockMetadata(metadata),
        }
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
      this.socketPathObservable() &&
      (await this.verifyDaemonConnection(confirmBudget))
    ) {
      return true;
    }
    return false;
  }

  /** The shared lock metadata was historically just a base64url log path. */
  private startupLockMetadata(metadata?: string): {
    logPath: string;
    recovering?: boolean;
    metadataPending?: boolean;
  } {
    if (!metadata?.startsWith("{")) {
      return { logPath: Buffer.from(metadata ?? "", "base64url").toString("utf8") };
    }
    try {
      const value: unknown = JSON.parse(metadata);
      if (typeof value === "object" && value !== null && "logPath" in value) {
        return {
          logPath: typeof value.logPath === "string" ? value.logPath : "",
          recovering: "recovering" in value && value.recovering === true,
        };
      }
    } catch (error) {
      // Concurrent in-place writes can tear JSON: retry before trusting readiness.
      logger.debug("Startup lock metadata is not yet readable", error);
      return { logPath: "", recovering: true, metadataPending: true };
    }
    return { logPath: "" };
  }

  /** Update only our owned inode; releaseLock removes the marker with the lock. */
  private markStartupLockRecovering(): void {
    const holder = this.readStartupLockHolder();
    if (holder.livePid !== process.pid || holder.token !== this.startupLockOwnerToken) {
      return;
    }
    // Filesystem capabilities belong to the host, not the simulated recovery platform.
    const { noFollow, unsafeWriteMask } =
      process.platform === "win32"
        ? { noFollow: 0, unsafeWriteMask: 0 }
        : { noFollow: constants.O_NOFOLLOW, unsafeWriteMask: 0o022 };
    let fd: number;
    try {
      fd = openSync(this.lockFilePath, constants.O_RDWR | noFollow, 0o600);
    } catch (error) {
      logger.warn("Failed to safely open startup lock for identity recovery", error);
      return;
    }
    try {
      const stats = fstatSync(fd);
      const uid = process.getuid?.();
      if (
        !stats.isFile() ||
        (uid !== undefined && stats.uid !== uid) ||
        (stats.mode & unsafeWriteMask) !== 0
      ) {
        logger.warn("Refusing unsafe startup lock for identity recovery", {
          uid: stats.uid,
          mode: stats.mode,
          regularFile: stats.isFile(),
        });
        return;
      }
      const lockContents = readFileSync(fd, "utf8");
      const { pid, token, metadata } = parseLockContent(lockContents.trim());
      if (pid !== process.pid || token !== this.startupLockOwnerToken) {
        throw new ActionableError("Startup lock ownership changed before identity recovery");
      }
      const recoveryMetadata = JSON.stringify({
        logPath: this.startupLockMetadata(metadata).logPath,
        recovering: true,
      });
      const content = formatLockContent(pid, token, recoveryMetadata);
      // Pad shorter metadata so one write replaces the old body without a
      // write/truncate window in which followers could read trailing old bytes.
      writeSync(fd, content.padEnd(Buffer.byteLength(lockContents)), 0, "utf8");
    } finally {
      closeSync(fd);
    }
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
      const { logPath } = this.startupLockMetadata(metadata);
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
  async stop(timeout: number = DAEMON_SHUTDOWN_TIMEOUT_MS, expected?: DaemonStatus): Promise<void> {
    // Explicit stop must not repair or replace a missing generation before stopping it.
    let status = expected ?? (await this.status(false));
    if (!status.running && this.identityRecoveryIO.socketExists()) {
      status = await this.authenticateSocketOwner();
    }

    if (!status.running) {
      // Status never deletes files (issue #6140) and does not
      // reclaim a well-formed PID file naming an already-exited daemon.
      // `stop()` is a deliberate, explicit user action, so it is safe to
      // remove that CONFIRMED-DEAD daemon's PID FILE here — but NOT its
      // socket pathname (see removeConfirmedDeadPidFile for why).
      await this.removeConfirmedDeadPidFile();
      stderrLog("Daemon is not running");
      return;
    }

    await this.stopRunningDaemon(status, timeout);
  }

  /**
   * Recover a previously-unusable daemon control socket. Unlike a general
   * `restart()`, this takes the namespace startup lock *before* deciding
   * whether to stop anything, then makes a fresh protocol probe while holding
   * it. A concurrent recovery/start therefore publishes a healthy successor
   * that this call joins instead of deleting its socket or terminating it.
   *
   * This is deliberately invoked only after an initial health check fails. It
   * still stops only processes whose current
   * command line identifies them as AutoMobile daemon-mode processes, never a
   * PID named solely by stale control metadata.
   */
  async recoverControlState(
    options: DaemonOptions = {},
    isProtocolHealthy: () => Promise<boolean> = this.daemonProtocolHealthProbe,
    signal?: AbortSignal,
    recoveryDeadline?: number,
  ): Promise<DaemonRestartResult> {
    this.throwIfRecoveryCancelled(signal);
    if (!this.acquireLock()) {
      return restartResultFromStart(
        await this.startByAwaitingLockHolder(options, signal, async () => {
          const result = await this.recoverControlStateWhileLocked(
            options,
            isProtocolHealthy,
            signal,
            recoveryDeadline,
          );
          return result === "restarted" ? "started" : "joined";
        }),
      );
    }

    try {
      return await this.recoverControlStateWhileLocked(
        options,
        isProtocolHealthy,
        signal,
        recoveryDeadline,
      );
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Recovery transition for a lifecycle lock that the caller already owns.
   * Lock-contended recovery uses this after the prior holder exits so its
   * takeover retains the same successor, process, port, and strict-port checks
   * as an uncontended repair.
   */
  private async recoverControlStateWhileLocked(
    options: DaemonOptions,
    isProtocolHealthy: () => Promise<boolean>,
    signal: AbortSignal | undefined,
    recoveryDeadline: number | undefined,
  ): Promise<DaemonRestartResult> {
    if (await isProtocolHealthy()) {
      this.throwIfRecoveryCancelled(signal);
      stderrLog("Daemon became healthy during control-state recovery; joining it.");
      return "joined";
    }

    this.throwIfRecoveryCancelled(signal);
    const status = await this.lifecycleStatus();
    this.throwIfRecoveryCancelled(signal);
    const candidates = await this.findNamespaceDaemonProcessRecords(
      this.remainingRecoveryTime(recoveryDeadline),
    );
    const recordedCandidate = this.findRecoveryCandidate(status, candidates);
    this.assertRecoveryCandidateIsScoped(
      status,
      candidates.map((candidate) => candidate.pid),
      recordedCandidate,
    );
    this.throwIfRecoveryCancelled(signal);
    await this.stopRecoveryCandidate(recordedCandidate, signal, recoveryDeadline);

    // A cancellation after SIGTERM must still let the verified stop settle,
    // but must never begin a replacement daemon that the caller will no
    // longer wait to verify.
    this.throwIfRecoveryCancelled(signal);
    const recoveryOptions = await this.recoveryOptions(status, options);
    this.throwIfRecoveryCancelled(signal);
    await this.assertNoSurvivingDaemonBeforeRestart(recoveryOptions, recoveryDeadline);
    this.throwIfRecoveryCancelled(signal);
    await this.timer.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
    this.throwIfRecoveryCancelled(signal);
    return restartResultFromStart(await this.startUnlocked(recoveryOptions, signal));
  }

  private findRecoveryCandidate(
    status: DaemonStatus,
    candidates: DaemonProcessRecord[],
  ): DaemonProcessRecord | undefined {
    if (!status.running || status.pid === undefined || status.socketPath !== this.socketPath) {
      return undefined;
    }
    const candidate = candidates.find((process) => process.pid === status.pid);
    if (!candidate || !this.matchesRecordedDaemonGeneration(status, candidate)) {
      return undefined;
    }
    return candidate;
  }

  /**
   * Compare a PID file to the process table using the OS process-birth value
   * written by current daemons. PID files from before that field existed retain
   * a narrow, symmetric startedAt fallback: it supports normal old records but
   * refuses a slow-bootstrap process rather than accepting one merely because
   * it happens to be older than daemon initialization.
   */
  private matchesRecordedDaemonGeneration(
    status: DaemonStatus,
    candidate: DaemonProcessRecord,
  ): boolean {
    if (status.processGenerationToken !== undefined) {
      return candidate.processGenerationToken === status.processGenerationToken;
    }
    const expectedStartedAt = status.processStartedAt ?? status.startedAt;
    return (
      expectedStartedAt !== undefined &&
      candidate.startedAt !== undefined &&
      Math.abs(candidate.startedAt - expectedStartedAt) <=
        DAEMON_PROCESS_BIRTH_IDENTITY_TOLERANCE_MS
    );
  }

  private matchesObservedDaemonGeneration(
    expected: DaemonProcessRecord,
    candidate: DaemonProcessRecord,
  ): boolean {
    if (expected.processGenerationToken !== undefined) {
      return (
        expected.pid === candidate.pid &&
        candidate.processGenerationToken === expected.processGenerationToken
      );
    }
    return (
      expected.pid === candidate.pid &&
      expected.startedAt !== undefined &&
      candidate.startedAt !== undefined &&
      Math.abs(candidate.startedAt - expected.startedAt) <=
        DAEMON_PROCESS_BIRTH_IDENTITY_TOLERANCE_MS
    );
  }

  private isConfirmedDifferentDaemonGeneration(
    expected: DaemonProcessRecord,
    candidate: DaemonProcessRecord,
  ): boolean {
    if (expected.pid !== candidate.pid) {
      return false;
    }
    if (expected.processGenerationToken !== undefined) {
      return (
        candidate.processGenerationToken !== undefined &&
        candidate.processGenerationToken !== expected.processGenerationToken
      );
    }
    return (
      expected.startedAt !== undefined &&
      candidate.startedAt !== undefined &&
      Math.abs(candidate.startedAt - expected.startedAt) >
        DAEMON_PROCESS_BIRTH_IDENTITY_TOLERANCE_MS
    );
  }

  private assertRecoveryCandidateIsScoped(
    status: DaemonStatus,
    candidates: number[],
    recordedCandidate: DaemonProcessRecord | undefined,
  ): void {
    if (candidates.length > 0 && (recordedCandidate === undefined || candidates.length > 1)) {
      throw new ActionableError(
        "Daemon recovery could not correlate the failed control socket with exactly one live " +
          "AutoMobile daemon process. Refusing to stop an uncorrelated daemon; inspect " +
          "the namespace PID record and socket before retrying.",
      );
    }
    if (status.running && recordedCandidate === undefined) {
      throw new ActionableError(
        "Daemon recovery found live PID control metadata that does not match a current " +
          "AutoMobile daemon process. Refusing to signal a potentially reused PID.",
      );
    }
  }

  private throwIfRecoveryCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new ActionableError(
        "Daemon recovery deadline elapsed before a safe recovery transition could complete.",
      );
    }
  }

  private async stopRecoveryCandidate(
    recordedCandidate: DaemonProcessRecord | undefined,
    signal: AbortSignal | undefined,
    recoveryDeadline: number | undefined,
  ): Promise<void> {
    if (recordedCandidate === undefined) {
      return;
    }
    this.throwIfRecoveryCancelled(signal);
    stderrLog(
      `Repair force-stopping the verified daemon for this control namespace (PID ${recordedCandidate.pid})...`,
    );
    await this.stopUnrecordedDaemonProcess(recordedCandidate, recoveryDeadline, signal);
  }

  private remainingRecoveryTime(recoveryDeadline: number | undefined): number | undefined {
    if (recoveryDeadline === undefined) {
      return undefined;
    }
    const remaining = this.remainingTime(recoveryDeadline);
    if (remaining <= 0) {
      throw new ActionableError(
        "Daemon recovery deadline elapsed before process-table inspection could complete.",
      );
    }
    return remaining;
  }

  private async recoveryOptions(
    status: DaemonStatus,
    options: DaemonOptions,
  ): Promise<DaemonOptions> {
    const recordedOptions = status.options ?? (await this.readRecoveryOptionsFromPidFile());
    // CLI parsing materializes omitted one-way flags as false. False has no
    // corresponding "disable" argument, so forwarding it here would erase a
    // PID-recorded true option without an explicit user request.
    const requestedOptions = daemonProcessOptions(
      Object.fromEntries(
        Object.entries(options).filter(([, value]) => value !== undefined && value !== false),
      ) as DaemonOptions,
    );
    return mergeRestartOptions(daemonProcessOptions(recordedOptions), requestedOptions);
  }

  private async readRecoveryOptionsFromPidFile(): Promise<DaemonOptions> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.pidFilePath, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const pidData = parsed as Partial<PidFileData>;
      const options =
        pidData.options && typeof pidData.options === "object" && !Array.isArray(pidData.options)
          ? pidData.options
          : {};
      // Older PID files predate the options object but still record their
      // bound port. Preserve it so a dead-record recovery probes/restarts the
      // same endpoint rather than silently returning to the default.
      return {
        ...options,
        ...(typeof pidData.port === "number" && options.port === undefined
          ? { port: pidData.port }
          : {}),
      };
    } catch (error) {
      logger.debug(`Unable to recover daemon options from PID metadata: ${errorMessage(error)}`);
      return {};
    }
  }

  /**
   * Stop the exact generation already observed by the caller. Keeping this
   * snapshot through the signal closes the stale-restart gap where a second
   * status read could target a successor that another client just started.
   */
  private async stopRunningDaemon(
    status: DaemonStatus,
    timeout: number = DAEMON_SHUTDOWN_TIMEOUT_MS,
    signalFirst: boolean = true,
  ): Promise<void> {
    this.assertDaemonStatusNamespace(status);
    stderrLog(`Stopping daemon (PID ${status.pid})...`);

    const pid = status.pid!;
    const expected = this.daemonProcessRecordFromStatus(status);

    try {
      if (signalFirst) {
        // Send SIGTERM for graceful shutdown.
        await this.signalVerifiedDaemonGeneration(
          expected,
          "SIGTERM",
          `Daemon generation ${pid} exited before stop could signal it.`,
        );
      }

      // Wait for process to exit
      let waitResult = await this.waitForStop(pid, timeout, expected);
      let replacedByOtherGeneration = waitResult.replacedByOtherGeneration;

      if (!waitResult.stopped) {
        stderrLog(`Daemon did not stop gracefully, sending SIGKILL...`);
        await this.signalVerifiedDaemonGeneration(
          expected,
          "SIGKILL",
          `Daemon generation ${pid} exited before stop could force-stop it.`,
        );

        waitResult = await this.waitForStop(pid, DAEMON_FORCED_STOP_TIMEOUT_MS, expected);
        replacedByOtherGeneration ||= waitResult.replacedByOtherGeneration;
        if (!waitResult.stopped) {
          throw new ActionableError(`Daemon process ${pid} did not exit after SIGKILL`);
        }
      }

      if (!replacedByOtherGeneration) {
        await cleanupDaemonFiles({
          pidFilePath: this.pidFilePath,
          socketPaths: this.cleanupSocketPaths(status.socketPath),
          expectedPid: pid,
        });
      }

      stderrLog("Daemon stopped");
    } catch (error) {
      await this.handleStopRunningDaemonError(error, status, pid);
    }
  }

  private daemonProcessRecordFromStatus(status: DaemonStatus): DaemonProcessRecord {
    return {
      pid: status.pid!,
      ppid: 0,
      command: status.entryScript ?? "",
      startedAt: status.processStartedAt ?? status.startedAt,
      processGenerationToken: status.processGenerationToken,
    };
  }

  private assertDaemonStatusNamespace(status: DaemonStatus): void {
    if (status.socketPath !== this.socketPath) {
      throw new ActionableError(
        "Daemon stop could not attribute the recorded daemon to this socket namespace.",
      );
    }
  }

  private async signalVerifiedDaemonGeneration(
    expected: DaemonProcessRecord,
    signal: NodeJS.Signals,
    exitedMessage: string,
  ): Promise<void> {
    if (!(await this.verifyDaemonGenerationBeforeSignal(expected, undefined, "Daemon stop"))) {
      throw new DaemonGenerationExitedBeforeSignalError(exitedMessage);
    }
    this.processSignaler.signal(expected.pid, signal);
  }

  private async handleStopRunningDaemonError(
    error: unknown,
    status: DaemonStatus,
    pid: number,
  ): Promise<void> {
    if (error instanceof DaemonGenerationExitedBeforeSignalError) {
      // Liveness confirmed death; no signal or socket cleanup is needed.
      logger.debug("Recorded daemon generation died before signalling", error);
      await this.removeConfirmedDeadPidFile();
      stderrLog(error.message);
      return;
    }
    if (error instanceof Error && error.message.includes("ESRCH")) {
      await cleanupDaemonFiles({
        pidFilePath: this.pidFilePath,
        socketPaths: this.cleanupSocketPaths(status.socketPath),
        expectedPid: pid,
      });
      stderrLog("Daemon was not running (cleaned up stale PID file)");
      return;
    }
    if (error instanceof Error && error.message.includes("EPERM")) {
      throw new ActionableError(
        `Cannot stop daemon process ${pid}: this user cannot signal it (EPERM). ` +
          "Run stop as the process's owning user, or via launchctl/systemd if managed that way.",
        { cause: error },
      );
    }
    throw error;
  }

  /**
   * Reads the PID file and returns its data only if it names a CONFIRMED-DEAD
   * PID (a well-formed record whose recorded process is not currently running).
   * Returns `undefined` for a missing file, a malformed record, or a record
   * naming a still-live process — all of which mean "nothing to clean up here".
   */
  private async readConfirmedDeadPidData(): Promise<PidFileData | undefined> {
    if (!existsSync(this.pidFilePath)) {
      return undefined;
    }
    try {
      const pidFileContent = await readFile(this.pidFilePath, "utf-8");
      const pidData: PidFileData = JSON.parse(pidFileContent);
      if (typeof pidData.pid !== "number" || this.isRecordedDaemonRunning(pidData)) {
        return undefined;
      }
      return pidData;
    } catch (error) {
      logger.warn(`Failed to read PID file during stop(): ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * A dead record that names a former owner of a control socket still on disk
   * is the ONLY evidence the next start's bind guard can use to prove that
   * socket reclaimable (issue #10107). Deleting it would leave a socket nobody
   * may ever unlink, so it stays; status() already derives "not running" from
   * liveness, never from the file's presence.
   */
  private mustKeepDeadRecordAsSocketOwnerProof(record: PidFileData): boolean {
    return this.identityRecoveryIO.socketExists() && recordProvesFormerSocketOwner(record);
  }

  /**
   * Remove a well-formed PID file naming an already-exited daemon, from the
   * explicit `stop()` path only (issue #6140). The difference from `status()`
   * (which never deletes anything) is WHO calls this: an explicit, deliberate
   * `--daemon stop` action, never a passive status/isAvailable/health-diagnostic
   * probe a live startup winner could race.
   *
   * Deliberately removes ONLY the PID file — never the socket pathname. A
   * daemon publishes its control socket (`daemon.ts`, `UnixSocketServer.start()`)
   * BEFORE writing its final PID record, so a live startup winner can already
   * own the socket while the PID file still names the just-exited loser.
   * Unlinking the socket here (by pathname alone, with no lock held and no
   * cheap way to establish current ownership — the lsof/inode ownership-proof
   * machinery was deliberately removed earlier in #6140 for exactly this
   * reason) would delete that winner's live socket: the exact brick #6140 is
   * about. A leftover socket file is harmless. A later daemon start may reclaim
   * it only after its bind guard proves the listener unreachable and its recorded
   * owner dead; the startup lock itself is not that proof.
   *
   * Even the PID file alone is NOT unconditionally safe to delete on a single
   * read, though: a concurrent daemon start can rewrite it — with its own LIVE
   * record — between this method's liveness check and the eventual `unlink()`
   * (`cleanupDaemonFiles`'s own `expectedPid` check only re-reads the file, it
   * does not coordinate with a writer). Deleting that rewritten record would
   * make a live daemon unrecorded (`status()`/`stop()` would report it absent)
   * and reopen the startup DB-ownership gap an early-owner record exists to
   * close. So this ACQUIRES the SAME `O_EXCL` namespace startup lock a
   * concurrent `start()` holds while binding and publishing its own record,
   * bounded so `stop()` can never hang if a start holds the lock unusually
   * long, then RE-READS and RE-CONFIRMS the PID file under the lock before
   * deleting. Either `stop()` wins the race (deletes the truly-stale record;
   * the concurrent start then writes its own afterward) or the start wins it
   * (writes its live record; `stop()`'s re-read under the lock then sees a
   * live/different PID and skips). A lock that cannot be acquired within the
   * bound, or a record that no longer matches, both mean "skip deletion" —
   * never delete a record this method cannot prove is still the confirmed-dead
   * one.
   */
  private async removeConfirmedDeadPidFile(): Promise<void> {
    // Cheap unlocked pre-check: skip acquiring the lock entirely when there is
    // plainly nothing to clean up (already gone, or already live).
    const unlockedRecord = await this.readConfirmedDeadPidData();
    if (!unlockedRecord || this.mustKeepDeadRecordAsSocketOwnerProof(unlockedRecord)) {
      return;
    }

    const deadline = this.timer.now() + PID_FILE_DELETE_LOCK_ACQUIRE_TIMEOUT_MS;
    let acquired = this.acquireLock();
    while (!acquired && this.remainingTime(deadline) > 0) {
      await this.timer.sleep(Math.min(PID_FILE_DELETE_LOCK_POLL_MS, this.remainingTime(deadline)));
      acquired = this.acquireLock();
    }
    if (!acquired) {
      logger.warn(
        "Could not acquire the startup lock to remove a stale PID file during stop(); " +
          "leaving it for a later safe startup or explicit cleanup to supersede.",
      );
      return;
    }

    try {
      // RE-READ under the lock: a concurrent start could have rewritten the PID
      // file with its own live record in the window before the lock was ours.
      const pidData = await this.readConfirmedDeadPidData();
      if (!pidData || this.mustKeepDeadRecordAsSocketOwnerProof(pidData)) {
        return;
      }
      await cleanupDaemonFiles({
        pidFilePath: this.pidFilePath,
        socketPaths: [], // NEVER the socket — see the doc comment above.
        expectedPid: pidData.pid,
      });
    } catch (error) {
      logger.warn(
        `Failed to remove a confirmed-dead PID file during stop(): ${errorMessage(error)}`,
      );
    } finally {
      this.releaseLock();
    }
  }

  /** Status never deletes files. Only the authenticated provider may repair metadata. */
  async status(recoverIdentity = true): Promise<DaemonStatus> {
    if (!recoverIdentity) {
      return this.recordedStatus();
    }
    if (this.identityRecoveryInFlight) {
      return this.identityRecoveryInFlight;
    }
    const recorded = this.recordedStatus();
    if (recorded.running || !this.identityRecoveryIO.socketExists()) {
      return recorded;
    }
    this.identityRecoveryInFlight = this.recoverSocketIdentity();
    try {
      return await this.identityRecoveryInFlight;
    } finally {
      this.identityRecoveryInFlight = undefined;
    }
  }

  private recordedStatus(): DaemonStatus {
    const record = this.identityRecoveryIO.readRecord();
    return record && record.socketPath === this.socketPath && this.isRecordedDaemonRunning(record)
      ? { ...record, running: true }
      : { running: false };
  }

  /** Internal startup reads must not await the recovery that initiated this replacement. */
  private lifecycleStatus(): Promise<DaemonStatus> {
    return this.recoveryOwner ? Promise.resolve(this.recordedStatus()) : this.status();
  }

  private async authenticateSocketOwner(): Promise<DaemonStatus> {
    try {
      const owner = await this.identityRecoveryIO.probe();
      if (!this.isRecoveryOwner(owner)) {
        throw new ActionableError(
          "Socket owner did not provide a live, matching provider identity",
        );
      }
      return owner;
    } catch (error) {
      if (/ECONNREFUSED|ENOENT|Failed to connect to daemon/.test(errorMessage(error))) {
        // A stale socket with no listener is an expected post-crash state.
        logger.debug("No daemon listening on the recovery socket", error);
        return { running: false };
      }
      logger.warn("Daemon socket owner could not be authenticated", error);
      return {
        running: false,
        recovery: { state: "unauthenticated", reason: errorMessage(error) },
      };
    }
  }

  private isRecoveryOwner(owner: DaemonStatus): boolean {
    return (
      recoveryOwnerSchema.safeParse(owner).success &&
      owner.reportedPidFilePath === this.pidFilePath &&
      owner.reportedSocketPath === this.socketPath &&
      this.isProcessRunning(owner.pid!)
    );
  }

  private async recoverSocketIdentity(): Promise<DaemonStatus> {
    // Publish before the first incumbent RPC, not after deciding to replace it.
    // PID/token gating makes this inert for status callers without the lock.
    // Retain the marker until the enclosing lifecycle operation releases its lock,
    // including repair/unauthenticated outcomes: repaired records satisfy followers,
    // and release removes the marker so later starts cannot inherit stale recovery.
    this.markStartupLockRecovering();
    const owner = await this.authenticateSocketOwner();
    if (!owner.running) {
      return owner;
    }
    const result = await this.requestIdentityRepublish(owner);
    if (result.accepted) {
      return (
        (await this.tryVerifiedRepair(owner)) ?? {
          running: false,
          recovery: {
            state: "failed",
            reason: "Republish accepted without authoritative metadata",
          },
        }
      );
    }
    return {
      running: false,
      recovery: { state: "deferred", reason: result.reason, replacementOwner: owner },
    };
  }

  /** Only an explicit lifecycle operation may replace an authenticated incumbent. */
  private async replaceRecoveryOwner(owner: DaemonStatus): Promise<DaemonStatus> {
    this.recoveryOwner = owner;
    try {
      this.markStartupLockRecovering();
      const result = await this.restart({}, owner);
      return await this.waitForRecoverySuccessor(
        owner,
        result === "joined" ? "joined" : "replaced",
      );
    } catch (error) {
      logger.warn("Explicit daemon identity replacement did not complete", error);
      return {
        running: false,
        recovery: {
          state: error instanceof DaemonRestartDeferredError ? "deferred" : "failed",
          reason: errorMessage(error),
        },
      };
    } finally {
      this.recoveryOwner = undefined;
    }
  }

  private async waitForRecoverySuccessor(
    owner: DaemonStatus,
    state: "joined" | "replaced",
  ): Promise<DaemonStatus> {
    const deadline = this.timer.now() + 5000;
    while (this.timer.now() < deadline) {
      const live = await this.authenticateSocketOwner();
      if (
        live.running &&
        (state === "joined" || !this.isSameDaemonGeneration(live, owner)) &&
        this.hasPublishedRecoveryIdentity(live)
      ) {
        return this.verifiedRecoveryStatus(state, live);
      }
      await this.timer.sleep(100);
    }
    return {
      running: false,
      recovery: {
        state: "failed",
        reason: "Successor did not publish complete identity within 5000ms",
      },
    };
  }

  private async startIdentityRecovery(status: DaemonStatus): Promise<DaemonStartResult> {
    const owner = status.recovery?.replacementOwner;
    const result = owner ? await this.replaceRecoveryOwner(owner) : status;
    if (!result.running) {
      const reason = result.recovery?.reason ?? "Identity recovery could not be verified";
      if (result.recovery?.state === "deferred") {
        throw new DaemonRestartDeferredError(reason);
      }
      throw new ActionableError(reason);
    }
    return result.recovery?.state === "joined" ? "joined" : "replaced";
  }

  private async requestIdentityRepublish(
    owner: DaemonStatus,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const client = this.createClient({ clientIdentity: null });
    try {
      const result: unknown = await client.callDaemonMethod(DAEMON_REPUBLISH_IDENTITY_METHOD, {
        ...owner,
      });
      return republishResultSchema.parse(result);
    } catch (error) {
      logger.warn("In-place daemon identity publication unavailable", error);
      return { accepted: false, reason: "republish_unavailable" };
    } finally {
      await client.close();
    }
  }

  private hasPublishedRecoveryIdentity(owner: DaemonStatus): boolean {
    const record = this.identityRecoveryIO.readRecord();
    return (
      isCompleteRecoveryRecord(record, owner.reportedSockets ?? {}) &&
      this.isProcessRunning(record.pid) &&
      record.socketPath === this.socketPath &&
      this.isSameDaemonGeneration({ ...record, running: true }, owner)
    );
  }

  private async tryVerifiedRepair(owner: DaemonStatus): Promise<DaemonStatus | undefined> {
    try {
      return await this.verifiedRecoveryStatus("repaired", owner);
    } catch (error) {
      logger.warn("Daemon acknowledged repair without authoritative metadata", error);
      return undefined;
    }
  }

  private async verifiedRecoveryStatus(
    state: "repaired" | "replaced" | "joined",
    expected?: DaemonStatus,
  ): Promise<DaemonStatus> {
    const record = this.identityRecoveryIO.readRecord();
    const live = expected ?? (await this.identityRecoveryIO.probe());
    if (
      !this.isRecoveryOwner(live) ||
      !isCompleteRecoveryRecord(record, live.reportedSockets ?? {}) ||
      !this.isProcessRunning(record.pid) ||
      !this.isSameDaemonGeneration({ ...record, running: true }, live) ||
      (expected && !this.isSameDaemonGeneration(live, expected)) ||
      record.socketPath !== this.socketPath
    ) {
      throw new ActionableError("Daemon recovery did not publish complete authoritative metadata");
    }
    return { ...record, running: true, recovery: { state } };
  }

  /**
   * Restart the daemon
   */
  async restart(
    options: DaemonOptions = {},
    expectedDaemon?: DaemonStatus,
  ): Promise<DaemonRestartResult> {
    stderrLog("Restarting daemon...");
    // A bare `--daemon restart` has no CLI options, but it is commonly used to
    // replace a stale checkout. Preserve the daemon's PID-recorded options so
    // that replacement cannot silently discard configuration such as debug,
    // output, or accessibility flags.
    const recovering = expectedDaemon !== undefined && expectedDaemon === this.recoveryOwner;
    const status = recovering
      ? await this.identityRecoveryIO.probe()
      : await this.lifecycleStatus();
    if (recovering && !this.isRecoveryOwner(status)) {
      throw new DaemonRestartDeferredError("Provider identity changed before replacement");
    }
    if (recovering && this.hasPublishedRecoveryIdentity(status)) {
      return "joined";
    }
    const runningOptions = daemonProcessOptions({
      ...status.options,
      ...(status.port === undefined ? {} : { port: status.port }),
    });
    const requestedOptions = daemonProcessOptions(
      Object.fromEntries(
        Object.entries(options).filter(([, value]) => value !== undefined),
      ) as DaemonOptions,
    );
    // Force the authoritative bind-or-fail guard (issue #6260, PRRT ft82d):
    // the preflight check in assertNoSurvivingDaemonBeforeRestart below is
    // fast feedback only — it releases its probe socket before this sleep and
    // before the child actually binds, so a competitor can still win the
    // canonical port in that window. strictPort makes the child's own
    // listen() call the atomic guard, failing loudly instead of silently
    // falling back to port + 1..3 and recreating the split-brain.
    const restartOptions = mergeRestartOptions(runningOptions, requestedOptions);
    if (expectedDaemon && !this.isSameDaemonGeneration(status, expectedDaemon)) {
      stderrLog("Daemon generation changed before restart; joining the current generation");
      return "joined";
    }

    if (expectedDaemon) {
      return this.restartExpectedGeneration(status, expectedDaemon, restartOptions, recovering);
    }

    return this.restartNamespace(status, restartOptions);
  }

  private async restartNamespace(
    status: DaemonStatus,
    options: DaemonOptions,
  ): Promise<DaemonRestartResult> {
    // Stop only this namespace's observed generation and attributable orphans.
    // Keep the bounded graceful + forced-stop cleanup window.
    await this.awaitRestartCleanup([
      () => (status.running ? this.stop(DAEMON_SHUTDOWN_TIMEOUT_MS, status) : undefined),
      () => this.stopNamespaceOrphansForExplicitRestart(status.pid),
    ]);
    // Confirm the previous daemon(s) are actually gone before starting a
    // replacement (issue #6260). `awaitRestartCleanup` above only rejects when a
    // DISCOVERED candidate refused to stop; it cannot catch a candidate that
    // process-table discovery never found in the first place — the exact split-
    // brain #6260 reports, where `--daemon restart` printed no stop line at all,
    // then silently started a second daemon on a fallback port and reported
    // unqualified success while the old one kept CtrlProxy forwarding ownership.
    // Failing loudly here, naming the orphan, is strictly better than that.
    if (status.pid !== undefined && this.isProcessRunning(status.pid)) {
      throw new ActionableError(
        "Restart could not confirm the namespace's previous daemon exited; refusing to start a replacement.",
      );
    }
    await this.assertNoSurvivingDaemonBeforeRestart(options);
    // Wait a bit before starting
    await this.timer.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
    const startResult = await this.start(options);
    const successor = this.recordedStatus();
    if (
      status.running &&
      successor.pid === status.pid &&
      !this.isConfirmedDifferentDaemonGeneration(
        this.daemonProcessRecordFromStatus(status),
        this.daemonProcessRecordFromStatus(successor),
      )
    ) {
      throw new ActionableError(
        "Restart did not replace the namespace's previous daemon generation.",
      );
    }
    return restartResultFromStart(startResult);
  }

  private async restartExpectedGeneration(
    status: DaemonStatus,
    expected: DaemonStatus,
    options: DaemonOptions,
    recovering: boolean,
  ): Promise<DaemonRestartResult> {
    const preparation = recovering
      ? await this.prepareIdentityRecoveryRestart(expected)
      : await this.prepareDaemonForConditionalRestart(expected);
    if (!preparation.accepted) {
      if (preparation.reason === "generation_changed" || preparation.reason === "restart_pending") {
        stderrLog("Daemon restart is already in progress; joining its successor");
        return "joined";
      }
      if (preparation.reason === "active_operations") {
        throw new DaemonRestartDeferredError("a device operation is active");
      }
      if (preparation.reason === "shutdown_unavailable") {
        throw new DaemonRestartDeferredError("the daemon could not initiate its own shutdown");
      }
      throw new DaemonRestartDeferredError(
        "the daemon returned an unrecognized safe-restart admission result",
      );
    }
    if (status.running) {
      // Atomic admission asks the daemon to initiate its own shutdown before
      // acknowledging. Waiting without a second SIGTERM prevents a delayed
      // manager from acting on stale admission state.
      await this.stopRunningDaemon(status, DAEMON_SHUTDOWN_TIMEOUT_MS, false);
    }
    // Another automatic client may win the shared startup lock during this
    // handoff. Ordinary start() joins that winner instead of terminating it.
    await this.timer.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
    // Recovery already owns the startup lock; do not recursively acquire it.
    const startResult = recovering ? await this.startUnlocked(options) : await this.start(options);
    return restartResultFromStart(startResult);
  }

  /**
   * Complete a host-maintenance restart only after the generation that minted
   * its opaque maintenance token accepts it. This RPC is intentionally the
   * first lifecycle action: a successor that replaced the admitted daemon
   * cannot present the old token, so no stop, process-table scan, socket
   * cleanup, or replacement launch can follow a stale admission.
   */
  async restartAdmitted(
    options: DaemonOptions,
    maintenanceToken: string,
  ): Promise<DaemonRestartResult> {
    if (!maintenanceToken) {
      throw new ActionableError("restart-admitted requires a maintenance admission token.");
    }
    if (!this.acquireLock()) {
      throw new DaemonRestartDeferredError("another daemon lifecycle transition is in progress");
    }
    try {
      return await this.restartAdmittedWhileLocked(options, maintenanceToken);
    } finally {
      this.releaseLock();
    }
  }

  private async restartAdmittedWhileLocked(
    options: DaemonOptions,
    maintenanceToken: string,
  ): Promise<DaemonRestartResult> {
    const status = await this.lifecycleStatus();
    if (!status.running) {
      throw new ActionableError(
        "restart-admitted requires the daemon generation that admitted maintenance to still be running.",
      );
    }

    const admission = await this.admitMaintenanceRestart(status, maintenanceToken);
    if (!admission.accepted) {
      throw new DaemonRestartDeferredError(
        `maintenance admission is no longer valid (${admission.reason ?? "unknown"})`,
      );
    }

    const restartOptions = mergeRestartOptions(
      daemonProcessOptions(status.options),
      daemonProcessOptions(
        Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
      ),
    );
    // The admitted daemon has already initiated its own SIGTERM before it
    // acknowledges. Preserve the exact pre-admission status through the wait;
    // a later status read could name its replacement instead.
    await this.stopRunningDaemon(status, DAEMON_SHUTDOWN_TIMEOUT_MS, false);
    await this.timer.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
    return restartResultFromStart(await this.startUnlocked(restartOptions));
  }

  private isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean {
    if (!current.running || !expected.running || current.pid !== expected.pid) {
      return false;
    }
    const identityFields = [
      "startedAt",
      "processStartedAt",
      "processGenerationToken",
      "version",
      "buildId",
      "entryScript",
    ] as const;
    return identityFields.every(
      (field) => expected[field] === undefined || current[field] === expected[field],
    );
  }

  /**
   * Crash and replace one verified live-acceptance daemon generation without a
   * graceful shutdown. This preserves precisely one authenticated persisted
   * session row for recovery testing; the admission RPC rejects unrelated
   * sessions and active operations before this manager signals the process.
   */
  async restartAcceptanceSession(
    scope: AcceptanceSessionRestartScope,
  ): Promise<DaemonRestartResult> {
    const startupSecret = daemonLiveAcceptanceStartupSecret();
    if (!startupSecret) {
      throw new ActionableError(
        "restart-acceptance-session requires a live-acceptance daemon startup capability.",
      );
    }
    if (!this.acquireLock()) {
      throw new ActionableError(
        "restart-acceptance-session could not acquire the daemon startup lock.",
      );
    }
    try {
      return await this.restartAcceptanceSessionWhileLocked(scope, startupSecret);
    } finally {
      this.releaseLock();
    }
  }

  private async restartAcceptanceSessionWhileLocked(
    scope: AcceptanceSessionRestartScope,
    startupSecret: string,
  ): Promise<DaemonRestartResult> {
    const status = await this.lifecycleStatus();
    if (!status.running) {
      throw new ActionableError(
        "restart-acceptance-session requires the admitted daemon generation to be running.",
      );
    }
    const generation = daemonGenerationIdentityFromStatus(status);
    if (!generation) {
      throw new ActionableError(
        "restart-acceptance-session requires the admitted daemon generation identity.",
      );
    }
    const client = this.createClient({ clientIdentity: null });
    let restartToken: string | undefined;
    let signalSent = false;
    let primaryError: unknown;
    let replacedByOtherGeneration = false;
    try {
      await client.connect();
      restartToken = await this.requestAcceptanceRestartAdmission(
        client,
        status,
        generation,
        scope,
        startupSecret,
      );
      await this.commitAcceptanceRestartAdmission(client, status, restartToken);
      if (await this.verifyAcceptanceGenerationBeforeSignal(status, generation)) {
        this.processSignaler.signal(status.pid!, "SIGKILL");
        signalSent = true;
        const expected: DaemonProcessRecord = {
          pid: status.pid!,
          ppid: 0,
          command: status.entryScript ?? "",
          startedAt: status.processStartedAt ?? status.startedAt,
          ...(status.processGenerationToken === undefined
            ? {}
            : { processGenerationToken: status.processGenerationToken }),
        };
        const waitResult = await this.waitForStop(
          status.pid!,
          DAEMON_FORCED_STOP_TIMEOUT_MS,
          expected,
        );
        replacedByOtherGeneration = waitResult.replacedByOtherGeneration;
        if (!waitResult.stopped) {
          throw new ActionableError(
            `Acceptance-session restart daemon process ${status.pid} did not exit after SIGKILL.`,
          );
        }
      }
    } catch (error) {
      primaryError = error;
      if (restartToken && !signalSent) {
        await this.rollbackAcceptanceRestartAdmission(client, status, restartToken);
      }
      throw error;
    } finally {
      await this.closeAcceptanceRestartClient(client, primaryError);
    }
    await this.cleanupAcceptanceRestartFiles(status, replacedByOtherGeneration);
    await this.timer.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
    return restartResultFromStart(
      await this.startUnlocked({ ...daemonProcessOptions(status.options), strictPort: true }),
    );
  }

  private async cleanupAcceptanceRestartFiles(
    status: DaemonStatus,
    replacedByOtherGeneration: boolean,
  ): Promise<void> {
    if (replacedByOtherGeneration) {
      return;
    }
    await cleanupDaemonFiles({
      pidFilePath: this.pidFilePath,
      socketPaths: this.cleanupSocketPaths(status.socketPath),
      expectedPid: status.pid!,
    });
  }

  private async requestAcceptanceRestartAdmission(
    client: DaemonClientLike,
    status: DaemonStatus,
    generation: DaemonGenerationIdentity,
    scope: AcceptanceSessionRestartScope,
    startupSecret: string,
  ): Promise<string> {
    const result: unknown = await client.callDaemonMethod(
      DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
      {
        ...status,
        scope,
        acceptanceCapability: createDaemonLiveAcceptanceScopedCapability(
          startupSecret,
          generation,
          scope,
        ),
      },
    );
    const admission = result as Partial<DaemonAcceptanceSessionRestart> | null;
    if (admission?.accepted !== true) {
      throw new ActionableError(
        `Daemon declined the acceptance-session restart (${admission?.reason ?? "unknown"}).`,
      );
    }
    if (!admission.restartToken) {
      throw new ActionableError(
        "Daemon accepted the acceptance-session restart without a rollback token.",
      );
    }
    return admission.restartToken;
  }

  private async commitAcceptanceRestartAdmission(
    client: DaemonClientLike,
    status: DaemonStatus,
    restartToken: string,
  ): Promise<void> {
    const result: unknown = await client.callDaemonMethod(DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD, {
      ...status,
      restartToken,
    });
    if ((result as Partial<DaemonAcceptanceRestartCommit> | null)?.committed !== true) {
      throw new ActionableError(
        "Daemon acceptance-session restart admission expired before it could be committed.",
      );
    }
  }

  private async rollbackAcceptanceRestartAdmission(
    client: DaemonClientLike,
    status: DaemonStatus,
    restartToken: string,
  ): Promise<void> {
    try {
      await client.callDaemonMethod(DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD, {
        ...status,
        restartToken,
      });
    } catch (rollbackError) {
      logger.warn(
        `Failed to explicitly roll back acceptance restart admission: ${errorMessage(rollbackError)}`,
      );
    }
  }

  private async closeAcceptanceRestartClient(
    client: DaemonClientLike,
    primaryError: unknown,
  ): Promise<void> {
    try {
      await client.close();
    } catch (closeError) {
      if (primaryError === undefined) {
        throw closeError;
      }
      logger.warn(
        `Failed to close acceptance restart control client after primary failure: ${errorMessage(closeError)}`,
      );
    }
  }

  /**
   * Revalidate the OS process generation immediately before an acceptance-only
   * SIGKILL. Admission authenticates the daemon that handled the RPC, but that
   * generation may exit before this manager signals its formerly owned PID.
   */
  private async verifyAcceptanceGenerationBeforeSignal(
    status: DaemonStatus,
    generation: DaemonGenerationIdentity,
  ): Promise<boolean> {
    return this.verifyDaemonGenerationBeforeSignal(
      {
        pid: generation.pid,
        ppid: 0,
        command: "",
        startedAt: status.processStartedAt ?? generation.startedAt,
        ...(generation.processGenerationToken === undefined
          ? {}
          : { processGenerationToken: generation.processGenerationToken }),
      },
      undefined,
      "Live acceptance",
    );
  }

  private async prepareDaemonForConditionalRestart(
    expected: DaemonStatus,
  ): Promise<DaemonRestartPreparation> {
    // The generation tuple below authorizes this lifecycle RPC. It must reach
    // an older daemon even when its normal client compatibility handshake would
    // reject the newer caller that is requesting the replacement.
    const client = this.createClient({ clientIdentity: null });
    try {
      await client.connect();
      const result: unknown = await client.callDaemonMethod(DAEMON_PREPARE_RESTART_METHOD, {
        pid: expected.pid,
        startedAt: expected.startedAt,
        processGenerationToken: expected.processGenerationToken,
        version: expected.version,
        buildId: expected.buildId,
        entryScript: expected.entryScript,
      });
      if (!result || typeof result !== "object") {
        throw new DaemonRestartDeferredError(
          "the daemon returned no safe-restart admission result",
        );
      }
      const preparation = result as Partial<DaemonRestartPreparation>;
      if (preparation.accepted === true) {
        return { accepted: true };
      }
      if (
        preparation.accepted === false &&
        (preparation.reason === "generation_changed" ||
          preparation.reason === "restart_pending" ||
          preparation.reason === "active_operations" ||
          preparation.reason === "shutdown_unavailable")
      ) {
        return { accepted: false, reason: preparation.reason };
      }
      throw new DaemonRestartDeferredError(
        "the daemon returned an unrecognized safe-restart admission result",
      );
    } catch (error) {
      if (error instanceof DaemonRestartDeferredError) {
        throw error;
      }
      // Older daemon generations do not implement atomic restart admission.
      // Fail closed: an explicit operator restart remains available.
      throw new DaemonRestartDeferredError(
        `safe-restart admission is unavailable: ${errorMessage(error)}`,
      );
    } finally {
      await client.close();
    }
  }

  private async prepareIdentityRecoveryRestart(
    expected: DaemonStatus,
  ): Promise<DaemonRestartPreparation> {
    // Without a known DB path a replacement could silently open a different database.
    if (!expected.dbPath || !expected.options) {
      throw new DaemonRestartDeferredError(
        "incumbent database path or startup options unavailable",
      );
    }
    const client = this.createClient({ clientIdentity: null });
    let maintenanceToken: string | undefined;
    try {
      const raw: unknown = await client.callDaemonMethod(DAEMON_PREPARE_MAINTENANCE_METHOD, {
        ...expected,
      });
      const result = republishResultSchema.passthrough().parse(raw);
      if (!result.accepted || typeof result.maintenanceToken !== "string") {
        throw new DaemonRestartDeferredError(result.reason ?? "maintenance admission unavailable");
      }
      maintenanceToken = result.maintenanceToken;
      const admitted = await this.admitMaintenanceRestart(expected, maintenanceToken);
      if (!admitted.accepted) {
        throw new DaemonRestartDeferredError(admitted.reason ?? "maintenance admission refused");
      }
      return { accepted: true };
    } finally {
      if (maintenanceToken) {
        try {
          await client.callDaemonMethod(DAEMON_COMPLETE_MAINTENANCE_METHOD, {
            ...expected,
            maintenanceToken,
          });
        } catch (error) {
          // An admitted daemon may already have closed its control socket for shutdown.
          logger.debug("Maintenance release after identity recovery unavailable", error);
        }
      }
      await client.close();
    }
  }

  private async admitMaintenanceRestart(
    expected: DaemonStatus,
    maintenanceToken: string,
  ): Promise<DaemonAdmittedRestart> {
    const client = this.createClient({ clientIdentity: null });
    try {
      await client.connect();
      const result: unknown = await client.callDaemonMethod(DAEMON_RESTART_ADMITTED_METHOD, {
        pid: expected.pid,
        startedAt: expected.startedAt,
        processGenerationToken: expected.processGenerationToken,
        version: expected.version,
        buildId: expected.buildId,
        entryScript: expected.entryScript,
        maintenanceToken,
      });
      if (!result || typeof result !== "object") {
        return { accepted: false, reason: "maintenance_token_invalid" };
      }
      const admission = result as Partial<DaemonAdmittedRestart>;
      if (admission.accepted === true) {
        return { accepted: true };
      }
      if (admission.accepted === false && isDaemonAdmittedRestartReason(admission.reason)) {
        return { accepted: false, reason: admission.reason };
      }
      return { accepted: false, reason: "maintenance_token_invalid" };
    } catch (error) {
      throw new DaemonRestartDeferredError(
        `maintenance admission is unavailable: ${errorMessage(error)}`,
      );
    } finally {
      await client.close();
    }
  }

  /**
   * Last line of defense before an explicit restart starts a replacement daemon
   * (issue #6260). Two independent confirmations, either of which fails loudly
   * rather than letting `start()` silently fall back to a different port:
   *
   * 1. Re-scan attributable processes: if this namespace's daemon survives,
   *    refuse to start a second owner. Foreign namespace processes are ignored.
   * 2. Probe the replacement's configured/recorded port directly: detection can miss a
   *    live daemon (a stale/mismatched PID record, a process-table scan that
   *    raced the kill) even when the port it holds is unmistakably still bound.
   *    A definitive "the port is still taken" is worth failing on even without a
   *    named PID.
   */
  private async assertNoSurvivingDaemonBeforeRestart(
    options: DaemonOptions,
    recoveryDeadline?: number,
  ): Promise<void> {
    const survivors = (
      await this.findNamespaceDaemonProcessRecords(this.remainingRecoveryTime(recoveryDeadline))
    ).map((candidate) => candidate.pid);
    if (survivors.length > 0) {
      throw new ActionableError(
        `Restart could not confirm this namespace's previous daemon stopped: ` +
          `PID(s) ${survivors.join(", ")} still running in this socket namespace. ` +
          "Verify the `--daemon-mode` socket marker, namespace PID record, socket owner and process generation before retrying `--daemon restart`.",
      );
    }

    const port = options.port ?? DEFAULT_DAEMON_PORT;
    const host = options.host ?? DEFAULT_DAEMON_HOST;
    if (
      await this.portAvailabilityChecker.isPortFree(
        port,
        host,
        this.remainingRecoveryTime(recoveryDeadline),
      )
    ) {
      return;
    }
    throw new ActionableError(
      `Restart stopped this namespace's verified daemon candidates, but replacement port ${port} on ${host} ` +
        `is still in use. Refusing to silently start the replacement daemon on a fallback port — ` +
        `that is how an orphaned process ends up owning device forwarding while a second daemon ` +
        `reports success. Find and stop whatever still holds port ${port} (it may not be an ` +
        `AutoMobile process this scan could name) and run \`--daemon restart\` again.`,
    );
  }

  /**
   * Explicit restart may stop an orphan only when its marker or this socket's
   * response attributes it to this namespace. Ordinary start remains non-destructive.
   */
  private async stopNamespaceOrphansForExplicitRestart(recordedPid?: number): Promise<void> {
    const candidates = (await this.findNamespaceDaemonProcessRecords()).filter(
      (candidate) => candidate.pid !== recordedPid,
    );
    if (candidates.length === 0) {
      return;
    }

    stderrLog(
      `Explicit restart force-stopping ${candidates.length} live AutoMobile daemon candidate(s) without this namespace's PID record...`,
    );
    await this.awaitRestartCleanup(
      candidates.map((candidate) => () => this.stopExplicitRestartDaemonProcess(candidate)),
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

  /**
   * Re-scan immediately before each signal and require the exact process-table
   * generation that was previously verified. A PID alone is never a safe signal
   * target: it may have been reused after the original candidate exited.
   */
  private async stopUnrecordedDaemonProcess(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!(await this.verifyDaemonGenerationBeforeSignal(expected, recoveryDeadline))) {
      stderrLog(`Daemon candidate ${expected.pid} exited before repair could stop it.`);
      return;
    }
    this.throwIfRecoveryCancelled(signal);

    stderrLog(
      `Repair stopping the verified daemon for this control namespace (PID ${expected.pid})...`,
    );
    try {
      this.processSignaler.signal(expected.pid, "SIGTERM");
    } catch (error) {
      if (this.isMissingProcessError(error)) {
        return;
      }
      throw new ActionableError(
        `Failed to stop verified daemon process ${expected.pid}: ${this.describeError(error)}`,
      );
    }

    if (
      (
        await this.waitForStop(
          expected.pid,
          this.stopWaitTimeout(DAEMON_SHUTDOWN_TIMEOUT_MS, recoveryDeadline),
          expected,
        )
      ).stopped
    ) {
      return;
    }

    stderrLog(`Verified daemon ${expected.pid} did not stop gracefully, sending SIGKILL...`);
    if (!(await this.verifyDaemonGenerationBeforeSignal(expected, recoveryDeadline))) {
      stderrLog(`Daemon candidate ${expected.pid} exited before repair could force-stop it.`);
      return;
    }
    this.throwIfRecoveryCancelled(signal);
    try {
      this.processSignaler.signal(expected.pid, "SIGKILL");
    } catch (error) {
      if (this.isMissingProcessError(error)) {
        return;
      }
      throw new ActionableError(
        `Failed to force-stop verified daemon process ${expected.pid}: ${this.describeError(error)}`,
      );
    }

    if (
      !(
        await this.waitForStop(
          expected.pid,
          this.stopWaitTimeout(DAEMON_FORCED_STOP_TIMEOUT_MS, recoveryDeadline),
          expected,
        )
      ).stopped
    ) {
      throw new ActionableError(
        `Verified daemon process ${expected.pid} did not exit after SIGKILL`,
      );
    }
  }

  private async stopExplicitRestartDaemonProcess(expected: DaemonProcessRecord): Promise<void> {
    if (!(await this.verifyDaemonGenerationBeforeSignal(expected, undefined, "Explicit restart"))) {
      stderrLog(`Daemon candidate ${expected.pid} exited before explicit restart could stop it.`);
      return;
    }

    stderrLog(`Stopping daemon without this namespace's PID record (PID ${expected.pid})...`);
    try {
      this.processSignaler.signal(expected.pid, "SIGTERM");
    } catch (error) {
      if (this.isMissingProcessError(error)) {
        return;
      }
      throw new ActionableError(
        `Failed to stop verified daemon process ${expected.pid}: ${this.describeError(error)}`,
      );
    }

    if ((await this.waitForStop(expected.pid, DAEMON_SHUTDOWN_TIMEOUT_MS, expected)).stopped) {
      return;
    }

    stderrLog(`Verified daemon ${expected.pid} did not stop gracefully, sending SIGKILL...`);
    if (!(await this.verifyDaemonGenerationBeforeSignal(expected, undefined, "Explicit restart"))) {
      stderrLog(
        `Daemon candidate ${expected.pid} exited before explicit restart could force-stop it.`,
      );
      return;
    }
    try {
      this.processSignaler.signal(expected.pid, "SIGKILL");
    } catch (error) {
      if (this.isMissingProcessError(error)) {
        return;
      }
      throw new ActionableError(
        `Failed to force-stop verified daemon process ${expected.pid}: ${this.describeError(error)}`,
      );
    }

    if (!(await this.waitForStop(expected.pid, DAEMON_FORCED_STOP_TIMEOUT_MS, expected)).stopped) {
      throw new ActionableError(
        `Verified daemon process ${expected.pid} did not exit after SIGKILL`,
      );
    }
  }

  /**
   * The recovery deadline is authoritative for the synchronous process-table
   * scan too. Check it before and after the scan because a blocking scan can
   * consume the final budget; signaling after that would violate fail-closed
   * daemon recovery semantics.
   */
  private async verifyDaemonGenerationBeforeSignal(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    context: string = "Daemon recovery",
  ): Promise<boolean> {
    if (!this.isProcessRunning(expected.pid)) {
      return false;
    }
    if (expected.startedAt === undefined && expected.processGenerationToken === undefined) {
      throw new ActionableError(
        `${context} could not verify the recorded daemon process generation before signalling it.`,
      );
    }
    const candidates = this.findLiveDaemonProcessRecords(
      this.remainingRecoveryTime(recoveryDeadline),
    );
    this.remainingRecoveryTime(recoveryDeadline);
    const current = candidates.find((candidate) => candidate.pid === expected.pid);
    this.assertObservedDaemonGeneration(expected, current, context);
    if (current && this.hasNamespaceRecordOrMarker(current)) {
      return this.isProcessRunning(expected.pid);
    }
    if (!current && this.isRecycledPid(expected)) {
      // The PID is alive but absent from the daemon process table, and its OS
      // generation token differs from the recorded daemon's: the recorded
      // generation exited and an unrelated process now holds the PID (issue
      // #10108). Nothing is signalled; callers only update start/stop bookkeeping.
      logger.info(
        `Recorded daemon PID ${expected.pid} is now held by a different process generation; treating the recorded daemon as exited`,
      );
      return false;
    }
    // An alive PID missing from ps is inconclusive, never proof of exit. A
    // self-identified namespace socket owner can supply the matching generation.
    const owner = await this.probeNamespaceOwner();
    this.remainingRecoveryTime(recoveryDeadline);
    if (!this.isProcessRunning(expected.pid)) {
      return false;
    }
    const refreshed = this.findLiveDaemonProcessRecords(
      this.remainingRecoveryTime(recoveryDeadline),
    ).find((candidate) => candidate.pid === expected.pid);
    this.remainingRecoveryTime(recoveryDeadline);
    this.assertObservedDaemonGeneration(expected, refreshed, context);
    if (this.matchesSocketOwnerBeforeSignal(owner, expected, refreshed)) {
      return this.isProcessRunning(expected.pid);
    }
    throw new ActionableError(
      `${context} could not verify the live PID's generation and ownership of this socket namespace; refusing to signal it.`,
    );
  }

  private assertObservedDaemonGeneration(
    expected: DaemonProcessRecord,
    current: DaemonProcessRecord | undefined,
    context: string,
  ): void {
    if (current && !this.matchesObservedDaemonGeneration(expected, current)) {
      throw new ActionableError(
        `${context} found that the verified daemon PID was reused before signalling it.`,
      );
    }
  }

  private matchesSocketOwnerBeforeSignal(
    owner: DaemonStatus | undefined,
    expected: DaemonProcessRecord,
    current: DaemonProcessRecord | undefined,
  ): boolean {
    if (!owner || owner.pid !== expected.pid) {
      return false;
    }
    // A matching ps generation permits legacy socket responses. An unlisted
    // live PID requires both modern self-reported namespace paths as well.
    if (
      !current &&
      (owner.reportedSocketPath !== this.socketPath ||
        owner.reportedPidFilePath !== this.pidFilePath)
    ) {
      return false;
    }
    if (current?.command.includes(DAEMON_SOCKET_PATH_FLAG)) {
      return false;
    }
    return this.matchesObservedDaemonGeneration(expected, {
      pid: owner.pid,
      ppid: 0,
      command: "",
      startedAt: owner.processStartedAt ?? owner.startedAt,
      processGenerationToken: owner.processGenerationToken,
    });
  }

  private stopWaitTimeout(timeoutMs: number, recoveryDeadline: number | undefined): number {
    const remaining = this.remainingRecoveryTime(recoveryDeadline);
    return remaining === undefined ? timeoutMs : Math.min(timeoutMs, remaining);
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
      if (this.socketPathObservable()) {
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
   * never race the client's deadline, so it needs no watchdog.
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
      return await this.probeObservedSocket(probeDeadline, watchdog?.signal ?? signal);
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
   * Deliberately NEVER unlinks the socket on an "unready" outcome (issue #6140): a
   * live daemon under load (a busy accept queue, a concurrent heavy operation) can
   * fail every readiness attempt within budget while still genuinely owning the
   * socket. The prior behavior unlinked the socket whenever `status()` reported the
   * recorded PID alive, on the theory that a SIGKILL'd daemon's PID could have been
   * reused by an unrelated process — but that same code path cannot distinguish
   * that rare case from an ordinary busy-but-alive daemon, and field evidence
   * (dogfood repro, issue #6140) confirms it fires on the latter. Deleting a
   * still-live daemon's socket combined with the #5253 guard (which then refuses to
   * replace a daemon it believes is alive) permanently bricks every later client
   * until an explicit `--daemon restart` — a strictly worse failure mode than the
   * readiness loop spinning out to its own timeout. A genuinely dead recorded PID
   * is already cleaned up by {@link status} itself, so no removal is needed here.
   */
  private async probeObservedSocket(
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<"ready" | "aborted" | "unready"> {
    if (await this.verifyDaemonConnection(this.remainingTime(deadline), signal)) {
      return "ready";
    }
    if (signal?.aborted) {
      return "aborted";
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

  /**
   * Rejoin a peer daemon coming up on the shared socket after our own spawned
   * subprocess exited before becoming ready (issue #6103).
   *
   * Under a concurrent cold start, multiple proxy clients each try to bring the
   * daemon up. Only one child wins ownership of the per-user socket; a losing child
   * exits — often with an empty launch log — a beat before the winner publishes the
   * socket. Surfacing that lost race as a terminal "subprocess exited before
   * becoming ready" error strands the caller even though a healthy same-namespace
   * daemon is ready ~1s later. This bounded wait joins that winner instead.
   *
   * Each iteration evaluates the authoritative socket probe FIRST; only after a probe
   * miss does it consult the process table, throttled to once up front plus once per
   * {@link PEER_DAEMON_PROCESS_SCAN_INTERVAL_MS} (that scan is a synchronous
   * `ps`/PowerShell call and must never precede or preempt the socket probe).
   *
   * Prompt-failure invariant (issues #5878/#5904): once the socket probe misses, a
   * GENUINE start failure — no live daemon process ({@link hasComingUpPeerDaemon}),
   * nothing coming up, or only an orphaned socket inode with no listener and no backing
   * process — fails immediately rather than burning the client's ~30s `tools/list`
   * budget; a peer that dies mid-wait ends the loop at the next re-check. `budgetMs` is
   * the time REMAINING under the caller's original start deadline, less a delivery
   * reserve (capped at {@link DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS}), so when
   * launchAndWait already consumed the client budget the caller passes a non-positive
   * value and skips this wait entirely — the rejoin can only ever spend time the caller
   * still has. It NEVER spawns — it only probes and joins, so it cannot double-spawn —
   * and it joins only a daemon that answers the observation-only
   * {@link peerSocketReachability} probe, which never unlinks or stale-cleans the socket
   * (so it cannot delete a live peer's endpoint); daemon version compatibility is
   * enforced separately by the proxy handshake.
   */
  private async tryJoinPeerDaemonAfterSpawnExit(budgetMs: number): Promise<boolean> {
    // A non-default PID/socket path means the process-table scan below cannot be
    // trusted to identify a peer IN THIS socket namespace (issue #6140) — bound the
    // whole rejoin to a short grace in that case rather than the caller's full
    // start budget. The default namespace keeps the full budget, matching #6103.
    // See {@link isIsolatedSocketNamespace} for why the comparison uses the
    // built-in DEFAULT_* constants rather than PID_FILE_PATH/SOCKET_PATH.
    const effectiveBudgetMs = this.isIsolatedSocketNamespace()
      ? Math.min(budgetMs, PEER_DAEMON_ISOLATED_NAMESPACE_GRACE_MS)
      : budgetMs;
    const deadline = this.timer.now() + effectiveBudgetMs;

    // The process-table scan is a synchronous `ps`/PowerShell/CIM call that blocks the
    // event loop, so it must (a) never run BEFORE the authoritative socket probe, and
    // (b) never run more than once up front plus once per
    // PEER_DAEMON_PROCESS_SCAN_INTERVAL_MS — otherwise a stalling scan could consume the
    // whole deadline before an already-published peer socket is ever checked (issue
    // #6103). It is populated lazily, only after a socket-probe miss.
    let peerProcessComingUp: boolean | undefined;
    let nextProcessScanAt = this.timer.now();

    while (this.remainingTime(deadline) > 0) {
      // SOCKET-FIRST (authoritative), evaluated before any process scan: a reachable
      // socket means join immediately, regardless of what the best-effort scan would
      // say. This is an observation-only probe — it never unlinks or stale-cleans the
      // socket, so it cannot delete a live peer's endpoint during the race — and it is
      // platform-aware at the connect layer so a Windows named-pipe peer (no filesystem
      // entry) is still reached.
      const probeBudget = Math.min(ABANDONED_WAIT_CONFIRM_TIMEOUT_MS, this.remainingTime(deadline));
      if (
        probeBudget > 0 &&
        (await this.peerSocketReachability.isReachable(this.socketPath, probeBudget))
      ) {
        stderrLog("Reusing a peer daemon that became ready after our launch exited");
        return true;
      }

      // Socket not reachable yet. NOW consult the process table — throttled — purely to
      // decide whether to keep waiting: a live peer process means the socket is still
      // coming up, so poll again; nothing coming up (genuine failure, or an orphaned
      // socket inode with no listener and no backing process) fails promptly (#5878).
      // The scan runs at most once up front (when still undefined) and once per interval
      // thereafter, so a peer that dies mid-wait still ends the loop without a scan per
      // poll. Recheck the deadline immediately before it: the scan itself is an
      // uncancellable synchronous call, so once the budget is exhausted it must
      // return rather than start a scan that can only blow past the deadline
      // (issue #6140, folded from PR #6109 review).
      const remainingForScan = this.remainingTime(deadline);
      if (remainingForScan === 0) {
        return false;
      }
      if (peerProcessComingUp === undefined || this.timer.now() >= nextProcessScanAt) {
        // Bound the scan itself by whatever remains of THIS loop's deadline, not just
        // the fixed DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS ceiling (issue #6140): with an
        // isolated-namespace grace or tight outer start-deadline headroom, the caller
        // can have far less than 5000ms left, and an exactly-zero check above does not
        // catch a small-but-nonzero remainder — the scan could still run to its full
        // ceiling and blow past both the grace and the outer delivery headroom before
        // the actionable launch error is ever delivered.
        peerProcessComingUp = await this.hasComingUpPeerDaemon(remainingForScan);
        nextProcessScanAt = this.timer.now() + PEER_DAEMON_PROCESS_SCAN_INTERVAL_MS;
      }
      if (!peerProcessComingUp) {
        // The process scan is a best-effort snapshot that can miss (or fail to inspect)
        // a peer that published its socket right after this iteration's probe. Do ONE
        // final observation-only socket probe before abandoning, so a just-published
        // winner is still joined rather than surfacing the loser's exit error (#6103).
        const finalBudget = Math.min(
          ABANDONED_WAIT_CONFIRM_TIMEOUT_MS,
          this.remainingTime(deadline),
        );
        if (
          finalBudget > 0 &&
          (await this.peerSocketReachability.isReachable(this.socketPath, finalBudget))
        ) {
          stderrLog("Reusing a peer daemon that became ready after our launch exited");
          return true;
        }
        return false;
      }
      const remaining = this.remainingTime(deadline);
      if (remaining === 0) {
        break;
      }
      await this.timer.sleep(Math.min(PEER_DAEMON_JOIN_POLL_MS, remaining));
    }

    return false;
  }

  /**
   * Whether a peer daemon is genuinely coming up and worth waiting on: a live
   * AutoMobile daemon process is present in the table.
   *
   * A bare socket INODE is deliberately NOT sufficient. An orphaned socket file —
   * left in the window after {@link startUnlocked}'s stale-file cleanup by a race
   * winner that bound the socket then died right after — has no listener and no
   * backing process; counting it as "coming up" would make
   * {@link tryJoinPeerDaemonAfterSpawnExit} poll out the full reachability budget
   * before failing, a delayed failure the prompt-failure invariant (#5878/#5904)
   * exists to prevent. The responding-listener case is handled directly by the
   * socket-first {@link probePeerSocketReachable} probe in that method, which returns
   * success the instant the socket accepts — so a socket that actually has a listener is
   * joined regardless of this gate, and a socket that does not is not waited on unless a
   * live daemon process backs it.
   */
  private async hasComingUpPeerDaemon(timeoutMs?: number): Promise<boolean> {
    try {
      return (await this.findNamespaceDaemonProcessRecords(timeoutMs)).length > 0;
    } catch (error) {
      // Best-effort recovery probe: a transient process-table inspection failure must
      // not REPLACE the caller's original spawn/exit diagnostic (which carries the
      // captured startup-log excerpt). Log it and treat it as "no peer coming up" so
      // the rejoin gives up and startUnlocked rethrows the original launch error intact
      // (issue #6103).
      logger.warn(
        `[DaemonManager] peer-daemon discovery failed during post-exit rejoin; treating as no peer coming up: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
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
      const done = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
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

  /**
   * Whether the daemon socket/pipe is observable at the filesystem layer before
   * attempting a connect. A Unix domain socket has a filesystem entry, so a
   * missing path means nothing is listening; a Windows named pipe has none, so
   * the existsSync gate must be skipped there entirely and the connect attempted
   * regardless (issue #6140) — mirroring {@link DaemonClient.isAvailable}'s
   * `platform() !== "win32"` branch.
   */
  private socketPathObservable(): boolean {
    return this.platform === "win32" || existsSync(this.socketPath);
  }

  /** Compare built-in defaults so environment-overridden namespaces keep their short rejoin grace. */
  private isIsolatedSocketNamespace(): boolean {
    return this.pidFilePath !== DEFAULT_PID_FILE_PATH || this.socketPath !== DEFAULT_SOCKET_PATH;
  }

  private async verifyDaemonConnection(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = this.timer.now() + timeoutMs;

    // Retry the connect probe before declaring the socket unready. A single failed
    // probe is not authoritative — a live daemon under load can transiently
    // refuse a connection. The caller never unlinks the socket on a retry
    // exhaustion (issue #6140): a socket that fails every attempt here may still
    // be owned by a genuinely live, merely busy daemon.
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
    try {
      await raceWithDeadline(client.connect(timeoutMs, probeAbort.signal), {
        timer: this.timer,
        timeoutMs,
        label: "Daemon readiness probe",
        timeoutError: () => new Error(`Daemon readiness probe timed out after ${timeoutMs}ms`),
        onTimeout: () => probeAbort.abort(),
      });
    } finally {
      probeAbort.abort();
      signal?.removeEventListener("abort", forwardAbort);
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

    const status = await this.lifecycleStatus();
    return (
      status.running === true &&
      status.pid === pid &&
      (await this.verifyDaemonConnection(timeoutMs, signal))
    );
  }

  /**
   * Wait for daemon process to stop
   */
  private async waitForStop(
    pid: number,
    timeout: number,
    expectedGeneration?: DaemonProcessRecord,
  ): Promise<WaitForStopResult> {
    const deadline = this.timer.now() + timeout;
    const pollInterval = 100;

    const replacementWasObserved = (candidates: DaemonProcessRecord[]): boolean => {
      if (expectedGeneration === undefined) {
        return false;
      }
      // The global process scan can find a different checkout's daemon after OS PID
      // reuse. Only this namespace's PID record naming that candidate proves it took
      // over our namespace rather than being an unrelated daemon elsewhere.
      const pidData = this.identityRecoveryIO.readRecord();
      if (pidData === null) {
        return false;
      }
      const recordedGeneration: DaemonProcessRecord = {
        pid: pidData.pid,
        ppid: 0,
        command: "",
        // Birth time, not daemon construction time: the process-table matcher
        // compares against the OS birth timestamp within a 2s tolerance.
        startedAt: pidData.processStartedAt ?? pidData.startedAt,
        ...(pidData.processGenerationToken === undefined
          ? {}
          : { processGenerationToken: pidData.processGenerationToken }),
      };
      return candidates.some(
        (candidate) =>
          this.isConfirmedDifferentDaemonGeneration(expectedGeneration, candidate) &&
          this.matchesObservedDaemonGeneration(recordedGeneration, candidate),
      );
    };

    const checkStopped = (): WaitForStopResult | undefined => {
      if (!this.isProcessRunning(pid)) {
        return { stopped: true, replacedByOtherGeneration: false };
      }
      if (expectedGeneration === undefined) {
        return undefined;
      }
      const scanBudget = this.remainingTime(deadline);
      if (scanBudget <= 0) {
        return undefined;
      }
      try {
        const candidates = this.findLiveDaemonProcessRecords(scanBudget);
        // Absence from ps does not prove that a still-live recorded PID exited.
        if (replacementWasObserved(candidates)) {
          return { stopped: true, replacedByOtherGeneration: true };
        }
      } catch (error) {
        // Safe: pre-SIGKILL generation verification remains the authoritative signaling gate.
        logger.debug(
          `[DaemonManager] replacement scan failed during stop; treating this poll as inconclusive: ${errorMessage(error)}`,
        );
      }
      return undefined;
    };

    while (this.remainingTime(deadline) > 0) {
      const result = checkStopped();
      if (result !== undefined) {
        return result;
      }
      await this.timer.sleep(pollInterval);
    }

    return checkStopped() ?? { stopped: false, replacedByOtherGeneration: false };
  }

  /**
   * Check if a process is running
   */
  private isProcessRunning(pid: number): boolean {
    return this.processLivenessChecker.isProcessRunning(pid);
  }

  /**
   * Whether the PID's current holder is DEFINITELY a different process
   * generation than the one recorded (issue #10108). A missing token reader or
   * any unreadable token answers false, so uncertainty keeps the PID trusted as
   * the recorded daemon exactly as before.
   */
  private isRecycledPid(record: { pid: number; processGenerationToken?: unknown }): boolean {
    const readToken = this.processLivenessChecker.readProcessGenerationToken;
    return (
      readToken !== undefined &&
      isConfirmedRecycledProcess(
        record.pid,
        record,
        (pid) => readToken.call(this.processLivenessChecker, pid),
        this.pidFilePath,
      )
    );
  }

  /** Alive by PID AND still the recorded generation (never a recycled PID). */
  private isRecordedDaemonRunning(record: {
    pid: number;
    processGenerationToken?: unknown;
  }): boolean {
    return this.isProcessRunning(record.pid) && !this.isRecycledPid(record);
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

export async function runDaemonCommand(
  command: string,
  args: string[],
  options: RunDaemonCommandOptions = {},
): Promise<void> {
  return runDaemonCommandWithManager(command, args, options, DaemonManager);
}
