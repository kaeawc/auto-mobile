import { defaultLockOwnerGenerationProbe } from "./lockOwnerGeneration";
import { type IdentityRecoveryIO } from "./identityRecovery";
import { createServer } from "node:net";
import type { DaemonManagerSeams, DaemonManagerTestInternals } from "./managerTestInternals";
import { fileSystemExtractionCleaner, type ExtractionCleaner } from "./extractionCleaner";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultDaemonExitRecordFileSystem } from "./daemonExitRecord";
import { getCurrentBuildIdentity } from "./buildIdentity";
import { existsSync, openSync, closeSync } from "node:fs";
import { logger, resolveAutomobileLogSink } from "../utils/logger";
import {
  PID_FILE_PATH,
  SOCKET_PATH,
  LOCK_FILE_PATH,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
} from "./constants";
import { DaemonStatus, DaemonOptions } from "./types";
import {
  DaemonClient,
  type DaemonClientFactory,
  type DaemonClientFactoryOptions,
  type DaemonClientLike,
} from "./client";
import {
  type AcceptanceSessionRestartScope,
  type DaemonAdmittedRestart,
  type DaemonRestartPreparation,
} from "./daemonRestartAdmission";
import { type DaemonRestartResult } from "./daemonRestart";
import {
  DaemonSocketReachability,
  type DaemonSocketReachabilityLike,
} from "./daemonSocketReachability";
import { type DaemonStateLike, daemonStateLikeFrom, defaultDaemonContext } from "./daemonContext";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { DefaultRetryExecutor, type RetryExecutor } from "../utils/retry/RetryExecutor";
import { readPidFileDataSync } from "./daemonFiles";
import { type ProcessGenerationRecordFields } from "./processGenerationFields";
import { type LockOwnerGenerationProbe } from "../utils/fileLock";
import { defaultIdGenerator } from "../utils/IdGenerator";
import {
  resolvePathFromDaemonLaunchWorkingDirectory,
  resolveStableDaemonWorkingDirectory,
} from "../utils/workingDirectory";
import { DaemonLauncher, type DaemonLaunchCommand } from "./DaemonLauncher";
import {
  createDefaultDaemonProcessFinder,
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
import type { DaemonManagerOptions } from "./managerOptions";
import type { WaitForStopResult } from "./manager/DaemonShutdown";
import type { StartupLockHolder } from "./manager/DaemonStartupLock";
import {
  DaemonProcessDiscovery,
  type DaemonProcessDiscoveryHost,
} from "./manager/DaemonProcessDiscovery";
import { DaemonStartupLock, type DaemonStartupLockHost } from "./manager/DaemonStartupLock";
import { DaemonStart, type DaemonStartHost } from "./manager/DaemonStart";
import { DefaultTakeoverDeferralLedger } from "./manager/TakeoverDeferralLedger";
import { FileStartupFailureStore } from "./FileStartupFailureStore";
import { DaemonLaunch, type DaemonLaunchHost } from "./manager/DaemonLaunch";
import {
  DaemonControlRecovery,
  type DaemonControlRecoveryHost,
} from "./manager/DaemonControlRecovery";
import { DaemonShutdown, type DaemonShutdownHost } from "./manager/DaemonShutdown";
import {
  DaemonIdentityRecovery,
  type DaemonIdentityRecoveryHost,
} from "./manager/DaemonIdentityRecovery";
import {
  DaemonRestartCoordinator,
  type DaemonRestartCoordinatorHost,
} from "./manager/DaemonRestartCoordinator";
import { DaemonReadiness, type DaemonReadinessHost } from "./manager/DaemonReadiness";
export type { DaemonLaunchCommand, DaemonProcessSpawner } from "./DaemonLauncher";
export { resolveExtractionRootForEntryScript, type ExtractionCleaner } from "./extractionCleaner";
export type { DaemonManagerOptions } from "./managerOptions";
export {
  DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
  PsDaemonProcessFinder,
  WindowsDaemonProcessFinder,
  createDefaultDaemonProcessFinder,
  parseBusyBoxDaemonProcessTable,
  parseDaemonProcessTable,
  parseDarwinDaemonProcessTable,
  parseWindowsDaemonProcessTable,
  type DaemonProcessFinder,
  type DaemonProcessLivenessChecker,
  type DaemonProcessRecord,
  type DaemonProcessSignaler,
} from "./processTable";
export { NetDaemonPortAvailabilityChecker } from "./portAvailability";
export type { DaemonPortAvailabilityChecker, ProbeListener } from "./portAvailability";
export { parseDaemonArgs } from "./cli/daemonArgs";
export {
  daemonBuildIdentityStatusLines,
  daemonCommandOptions,
  parseDaemonHeartbeatCommandArgs,
} from "./cli/runDaemonCommand";
export type { RunDaemonCommandOptions } from "./cli/runDaemonCommand";
export type { DaemonRestartResult };
export { relayDaemonStderr } from "./manager/DaemonLaunch";

type DaemonManagerHost = DaemonProcessDiscoveryHost &
  DaemonStartupLockHost &
  DaemonStartHost &
  DaemonLaunchHost &
  DaemonControlRecoveryHost &
  DaemonShutdownHost &
  DaemonIdentityRecoveryHost &
  DaemonRestartCoordinatorHost &
  DaemonReadinessHost;
type DaemonManagerDependencies = Pick<
  DaemonManagerHost,
  | "pidFilePath"
  | "takeoverDeferrals"
  | "processFinder"
  | "socketPath"
  | "identityRecoveryIO"
  | "retryExecutor"
  | "portAvailabilityChecker"
  | "lockFilePath"
  | "lockOwnerGenerationProbe"
  | "startupLockOwnerToken"
  | "heldLockLogPath"
  | "timer"
  | "seams"
  | "launcher"
  | "fallbackLauncher"
  | "extractionCleaner"
  | "recoveryOwner"
  | "launchCommandResolver"
  | "processSignaler"
  | "processLivenessChecker"
  | "peerSocketReachability"
  | "platform"
>;
type DaemonManagerOperations = Omit<DaemonManagerHost, keyof DaemonManagerDependencies>;

export class DaemonManager implements DaemonManagerLike {
  private get recoveryOwner(): DaemonStatus | undefined {
    return this.collaborators.daemonIdentityRecovery.recoveryOwner;
  }

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
  private get heldLockLogPath(): string | undefined {
    return this.collaborators.daemonStartupLock.heldLockLogPath;
  }

  /** Replaceable I/O seams (port probe, exit-record and launch-log files, cwd, build id) so tests need no real I/O. */
  protected readonly seams: DaemonManagerSeams = {
    portFreeProbe: isTcpPortFree,
    exitRecordFileSystem: defaultDaemonExitRecordFileSystem,
    launchLogFileSystem: { openSync, closeSync },
    launchWorkingDirectory: resolveStableDaemonWorkingDirectory,
    currentBuildId: () => getCurrentBuildIdentity().buildId,
    nextLaunchNonce: () => defaultIdGenerator.next(),
  };

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

  private readonly lockOwnerGenerationProbe: LockOwnerGenerationProbe;

  constructor(options: DaemonManagerOptions = {}) {
    const resolved = resolveDaemonManagerOptions(options);
    this.lockOwnerGenerationProbe = resolved.lockOwnerGenerationProbe;
    this.identityRecoveryIO = resolved.identityRecoveryIO ?? {
      // Windows uses argv/PID namespace attribution; POSIX socket-owner recovery is unavailable.
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
    this.platform = resolved.platform;
    this.portAvailabilityChecker = resolved.portAvailabilityChecker;
    this.retryExecutor = resolved.retryExecutor;
    this.startupLockOwnerToken = resolved.idGenerator.next();
    this.seams.nextLaunchNonce = () => resolved.idGenerator.next();
    // Construct with the injected timer so FakeTimer controls peer probes (#6103).
    this.peerSocketReachability =
      resolved.peerSocketReachability ?? new DaemonSocketReachability({ timer: resolved.timer });
    this.stateProvider = resolved.stateProvider;
    this.timer = resolved.timer;
    this.lockFilePath = resolvePathFromDaemonLaunchWorkingDirectory(resolved.lockFilePath);
    this.pidFilePath = resolvePathFromDaemonLaunchWorkingDirectory(resolved.pidFilePath);
    this.socketPath = resolvePathFromDaemonLaunchWorkingDirectory(resolved.socketPath);
    this.processFinder = resolved.processFinder;
    this.processLivenessChecker = hasProcessLivenessChecker(resolved.processFinder)
      ? resolved.processFinder
      : createDefaultDaemonProcessFinder();
    this.processSignaler = resolved.processSignaler;
    this.extractionCleaner = resolved.extractionCleaner;
    this.launchCommandResolver = resolved.launchCommandResolver;
    this.launcher =
      resolved.launcher ??
      new DaemonLauncher({
        spawn: resolved.processSpawner?.spawn.bind(resolved.processSpawner),
        timer: resolved.timer,
      });
    this.fallbackLauncher = new DaemonLauncher({
      entryScript: null,
      spawn: resolved.processSpawner?.spawn.bind(resolved.processSpawner),
      timer: resolved.timer,
    });
    this.clientFactory =
      resolved.clientFactory ??
      ((options) =>
        new DaemonClient(this.socketPath, undefined, resolved.timer, {}, options?.clientIdentity));
    this.daemonProtocolHealthProbe =
      resolved.daemonProtocolHealthProbe ??
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

  acquireLock(): boolean {
    return this.collaborators.daemonStartupLock.acquireLock();
  }

  releaseLock(): void {
    return this.collaborators.daemonStartupLock.releaseLock();
  }

  createClient(options?: DaemonClientFactoryOptions): DaemonClientLike {
    return this.clientFactory(options);
  }

  getDaemonState(): DaemonStateLike {
    return this.stateProvider();
  }

  private cleanupSocketPaths(primarySocketPath?: string): string[] | undefined {
    return this.collaborators.daemonProcessDiscovery.cleanupSocketPaths(primarySocketPath);
  }

  findAllDaemonProcesses(timeoutMs?: number): number[] {
    return this.collaborators.daemonProcessDiscovery.findAllDaemonProcesses(timeoutMs);
  }

  findOtherDaemonProcesses(activeDaemonPid: number | undefined): number[] {
    return this.collaborators.daemonProcessDiscovery.findOtherDaemonProcesses(activeDaemonPid);
  }

  findLiveDaemonProcesses(timeoutMs?: number): number[] {
    return this.collaborators.daemonProcessDiscovery.findLiveDaemonProcesses(timeoutMs);
  }

  private findLiveDaemonProcessRecords(timeoutMs?: number): DaemonProcessRecord[] {
    return this.collaborators.daemonProcessDiscovery.findLiveDaemonProcessRecords(timeoutMs);
  }

  private hasNamespaceRecordOrMarker(candidate: DaemonProcessRecord): boolean {
    return this.collaborators.daemonProcessDiscovery.hasNamespaceRecordOrMarker(candidate);
  }

  private probeNamespaceOwner(): Promise<DaemonStatus | undefined> {
    return this.collaborators.daemonProcessDiscovery.probeNamespaceOwner();
  }

  private findNamespaceDaemonProcessRecords(timeoutMs?: number): Promise<DaemonProcessRecord[]> {
    return this.collaborators.daemonProcessDiscovery.findNamespaceDaemonProcessRecords(timeoutMs);
  }

  findLiveDaemonProcessesForStart(
    options: DaemonOptions,
    startDeadline: number,
  ): Promise<number[]> {
    return this.collaborators.daemonProcessDiscovery.findLiveDaemonProcessesForStart(
      options,
      startDeadline,
    );
  }

  start(options: DaemonOptions = {}): Promise<DaemonStartResult> {
    return this.collaborators.daemonStart.start(options);
  }

  private startWithRunningOptions(options: DaemonOptions): Promise<DaemonStartResult> {
    return this.collaborators.daemonStart.startWithRunningOptions(options);
  }

  private startByAwaitingLockHolder(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    onTakeover?: () => Promise<DaemonStartResult>,
  ): Promise<DaemonStartResult> {
    return this.collaborators.daemonStartupLock.startByAwaitingLockHolder(
      options,
      recoverySignal,
      onTakeover,
    );
  }

  private readSettledStartupLockHolder(
    deadline: number,
    signal?: AbortSignal,
  ): Promise<StartupLockHolder> {
    return this.collaborators.daemonStartupLock.readSettledStartupLockHolder(deadline, signal);
  }

  private inheritExitSettings(options: DaemonOptions): Promise<DaemonOptions> {
    return this.collaborators.daemonStart.inheritExitSettings(options);
  }

  /** Requires the caller to hold the startup lock; collaborators reach it through the host. */
  private startUnlocked(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    inheritExitRecord: boolean = true,
  ): Promise<DaemonStartResult> {
    return this.collaborators.daemonStart.startUnlocked(options, recoverySignal, inheritExitRecord);
  }

  private launchWithExtractionRetry(
    launch: {
      options: DaemonOptions;
      childEnv: NodeJS.ProcessEnv;
      logSink: ReturnType<typeof resolveAutomobileLogSink>;
      capturesLaunchOutput: boolean;
      logFd: number;
      logPath: string;
    },
    initial: { command: string; args: string[] },
    startDeadline: number,
    recoverySignal: AbortSignal | undefined,
  ): Promise<void> {
    return this.collaborators.daemonLaunch.launchWithExtractionRetry(
      launch,
      initial,
      startDeadline,
      recoverySignal,
    );
  }

  private daemonLaunchEnvironment(options: DaemonOptions): NodeJS.ProcessEnv {
    return this.collaborators.daemonLaunch.daemonLaunchEnvironment(options);
  }

  withDaemonOptions(launch: DaemonLaunchCommand, options: DaemonOptions): DaemonLaunchCommand {
    return this.collaborators.daemonLaunch.withDaemonOptions(launch, options);
  }

  private resolveLaunchCommand(): DaemonLaunchCommand {
    return this.collaborators.daemonLaunch.resolveLaunchCommand();
  }

  private createLockHolderStartupFailure(retainedLogPath?: string | null): Promise<Error> {
    return this.collaborators.daemonLaunch.createLockHolderStartupFailure(retainedLogPath);
  }

  protected readStartupLockHolder(): StartupLockHolder {
    return this.collaborators.daemonStartupLock.readStartupLockHolder();
  }

  isStartupLockHeldByLiveProcess(): boolean {
    return this.collaborators.daemonStartupLock.isStartupLockHeldByLiveProcess();
  }

  waitForLockHolderReadiness(timeoutMs: number): Promise<boolean> {
    return this.collaborators.daemonStartupLock.waitForLockHolderReadiness(timeoutMs);
  }

  private markStartupLockRecovering(): void {
    return this.collaborators.daemonStartupLock.markStartupLockRecovering();
  }

  private getLockHolderStartupLogPath(): Promise<string | null> {
    return this.collaborators.daemonStartupLock.getLockHolderStartupLogPath();
  }

  private daemonLaunchLogPath(): string {
    return this.collaborators.daemonLaunch.daemonLaunchLogPath();
  }

  private createDaemonExitFailure(
    code: number | null,
    signal: NodeJS.Signals | null,
    logPath: string,
  ): Promise<Error> {
    return this.collaborators.daemonLaunch.createDaemonExitFailure(code, signal, logPath);
  }

  private describeError(error: unknown): string {
    return this.collaborators.daemonLaunch.describeError(error);
  }

  stop(timeout: number = DAEMON_SHUTDOWN_TIMEOUT_MS, expected?: DaemonStatus): Promise<void> {
    return this.collaborators.daemonShutdown.stop(timeout, expected);
  }

  recoverControlState(
    options: DaemonOptions = {},
    isProtocolHealthy: () => Promise<boolean> = this.daemonProtocolHealthProbe,
    signal?: AbortSignal,
    recoveryDeadline?: number,
  ): Promise<DaemonRestartResult> {
    return this.collaborators.daemonControlRecovery.recoverControlState(
      options,
      isProtocolHealthy,
      signal,
      recoveryDeadline,
    );
  }

  private matchesRecordedDaemonGeneration(
    status: DaemonStatus,
    candidate: DaemonProcessRecord,
  ): boolean {
    return this.collaborators.daemonControlRecovery.matchesRecordedDaemonGeneration(
      status,
      candidate,
    );
  }

  private matchesObservedDaemonGeneration(
    expected: DaemonProcessRecord,
    candidate: DaemonProcessRecord,
  ): boolean {
    return this.collaborators.daemonControlRecovery.matchesObservedDaemonGeneration(
      expected,
      candidate,
    );
  }

  private isConfirmedDifferentDaemonGeneration(
    expected: DaemonProcessRecord,
    candidate: DaemonProcessRecord,
  ): boolean {
    return this.collaborators.daemonControlRecovery.isConfirmedDifferentDaemonGeneration(
      expected,
      candidate,
    );
  }

  private throwIfRecoveryCancelled(signal: AbortSignal | undefined): void {
    return this.collaborators.daemonControlRecovery.throwIfRecoveryCancelled(signal);
  }

  private remainingRecoveryTime(recoveryDeadline: number | undefined): number | undefined {
    return this.collaborators.daemonControlRecovery.remainingRecoveryTime(recoveryDeadline);
  }

  private recoveryOptions(status: DaemonStatus, options: DaemonOptions): Promise<DaemonOptions> {
    return this.collaborators.daemonControlRecovery.recoveryOptions(status, options);
  }

  stopRunningDaemon(
    status: DaemonStatus,
    timeout: number = DAEMON_SHUTDOWN_TIMEOUT_MS,
    signalFirst: boolean = true,
  ): Promise<void> {
    return this.collaborators.daemonShutdown.stopRunningDaemon(status, timeout, signalFirst);
  }

  private daemonProcessRecordFromStatus(status: DaemonStatus): DaemonProcessRecord {
    return this.collaborators.daemonShutdown.daemonProcessRecordFromStatus(status);
  }

  protected removeConfirmedDeadPidFile(): Promise<void> {
    return this.collaborators.daemonShutdown.removeConfirmedDeadPidFile();
  }

  status(recoverIdentity: boolean = true): Promise<DaemonStatus> {
    return this.collaborators.daemonIdentityRecovery.status(recoverIdentity);
  }

  protected recordedStatus(): DaemonStatus {
    return this.collaborators.daemonIdentityRecovery.recordedStatus();
  }

  private lifecycleStatus(): Promise<DaemonStatus> {
    return this.collaborators.daemonIdentityRecovery.lifecycleStatus();
  }

  private authenticateSocketOwner(): Promise<DaemonStatus> {
    return this.collaborators.daemonIdentityRecovery.authenticateSocketOwner();
  }

  private isRecoveryOwner(owner: DaemonStatus): boolean {
    return this.collaborators.daemonIdentityRecovery.isRecoveryOwner(owner);
  }

  private recoverSocketIdentity(): Promise<DaemonStatus> {
    return this.collaborators.daemonIdentityRecovery.recoverSocketIdentity();
  }

  private replaceRecoveryOwner(owner: DaemonStatus): Promise<DaemonStatus> {
    return this.collaborators.daemonIdentityRecovery.replaceRecoveryOwner(owner);
  }

  private startIdentityRecovery(status: DaemonStatus): Promise<DaemonStartResult> {
    return this.collaborators.daemonIdentityRecovery.startIdentityRecovery(status);
  }

  private hasPublishedRecoveryIdentity(owner: DaemonStatus): boolean {
    return this.collaborators.daemonIdentityRecovery.hasPublishedRecoveryIdentity(owner);
  }

  restart(
    options: DaemonOptions = {},
    expectedDaemon?: DaemonStatus,
  ): Promise<DaemonRestartResult> {
    return this.collaborators.daemonRestartCoordinator.restart(options, expectedDaemon);
  }

  restartAdmitted(options: DaemonOptions, maintenanceToken: string): Promise<DaemonRestartResult> {
    return this.collaborators.daemonRestartCoordinator.restartAdmitted(options, maintenanceToken);
  }

  private isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean {
    return this.collaborators.daemonRestartCoordinator.isSameDaemonGeneration(current, expected);
  }

  restartAcceptanceSession(scope: AcceptanceSessionRestartScope): Promise<DaemonRestartResult> {
    return this.collaborators.daemonRestartCoordinator.restartAcceptanceSession(scope);
  }

  private cleanupAcceptanceRestartFiles(
    status: DaemonStatus,
    replacedByOtherGeneration: boolean,
  ): Promise<void> {
    return this.collaborators.daemonRestartCoordinator.cleanupAcceptanceRestartFiles(
      status,
      replacedByOtherGeneration,
    );
  }

  prepareDaemonForConditionalRestart(expected: DaemonStatus): Promise<DaemonRestartPreparation> {
    return this.collaborators.daemonRestartCoordinator.prepareDaemonForConditionalRestart(expected);
  }

  private prepareIdentityRecoveryRestart(
    expected: DaemonStatus,
  ): Promise<DaemonRestartPreparation> {
    return this.collaborators.daemonRestartCoordinator.prepareIdentityRecoveryRestart(expected);
  }

  private admitMaintenanceRestart(
    expected: DaemonStatus,
    maintenanceToken: string,
  ): Promise<DaemonAdmittedRestart> {
    return this.collaborators.daemonRestartCoordinator.admitMaintenanceRestart(
      expected,
      maintenanceToken,
    );
  }

  assertNoSurvivingDaemonBeforeRestart(
    options: DaemonOptions,
    recoveryDeadline?: number,
  ): Promise<void> {
    return this.collaborators.daemonShutdown.assertNoSurvivingDaemonBeforeRestart(
      options,
      recoveryDeadline,
    );
  }

  protected stopNamespaceOrphansForExplicitRestart(recordedPid?: number): Promise<void> {
    return this.collaborators.daemonShutdown.stopNamespaceOrphansForExplicitRestart(recordedPid);
  }

  private awaitRestartCleanup(
    operations: ReadonlyArray<() => void | Promise<void>>,
  ): Promise<void> {
    return this.collaborators.daemonShutdown.awaitRestartCleanup(operations);
  }

  private stopUnrecordedDaemonProcess(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return this.collaborators.daemonShutdown.stopUnrecordedDaemonProcess(
      expected,
      recoveryDeadline,
      signal,
    );
  }

  protected verifyDaemonGenerationBeforeSignal(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    context: string = "Daemon recovery",
  ): Promise<boolean> {
    return this.collaborators.daemonShutdown.verifyDaemonGenerationBeforeSignal(
      expected,
      recoveryDeadline,
      context,
    );
  }

  waitForReady(
    timeout: number,
    signal?: AbortSignal,
    shouldContinueWaiting: () => boolean = () => true,
    maxProbeDurationMs?: number,
    launchedProcess?: { pid: number | undefined; launchNonce?: string },
  ): Promise<boolean> {
    return this.collaborators.daemonReadiness.waitForReady(
      timeout,
      signal,
      shouldContinueWaiting,
      maxProbeDurationMs,
      launchedProcess,
    );
  }

  private tryJoinPeerDaemonAfterSpawnExit(budgetMs: number): Promise<boolean> {
    return this.collaborators.daemonReadiness.tryJoinPeerDaemonAfterSpawnExit(budgetMs);
  }

  waitForExistingDaemon(timeout: number): Promise<boolean> {
    return this.collaborators.daemonReadiness.waitForExistingDaemon(timeout);
  }

  private sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
    return this.collaborators.daemonReadiness.sleepUnlessAborted(ms, signal);
  }

  private remainingTime(deadline: number): number {
    return this.collaborators.daemonReadiness.remainingTime(deadline);
  }

  private socketPathObservable(): boolean {
    return this.collaborators.daemonReadiness.socketPathObservable();
  }

  /** Test-only typed view of the injectable collaborators and private steps suites drive. */
  getInternalsForTesting(): DaemonManagerTestInternals {
    return {
      seams: this.seams,
      identityRecoveryIO: this.identityRecoveryIO,
      inheritExitSettings: (options) => this.inheritExitSettings(options),
      recoveryOptions: (status, options) => this.recoveryOptions(status, options),
      tryJoinPeerDaemonAfterSpawnExit: (budgetMs) => this.tryJoinPeerDaemonAfterSpawnExit(budgetMs),
      isIsolatedSocketNamespace: () => this.isIsolatedSocketNamespace(),
    };
  }

  private isIsolatedSocketNamespace(): boolean {
    return this.collaborators.daemonReadiness.isIsolatedSocketNamespace();
  }

  private verifyDaemonConnection(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return this.collaborators.daemonReadiness.verifyDaemonConnection(timeoutMs, signal);
  }

  private isLaunchedProcessReady(
    pid: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
    launchNonce?: string,
  ): Promise<boolean> {
    return this.collaborators.daemonReadiness.isLaunchedProcessReady(
      pid,
      timeoutMs,
      signal,
      launchNonce,
    );
  }

  waitForStop(
    pid: number,
    timeout: number,
    expectedGeneration?: DaemonProcessRecord,
  ): Promise<WaitForStopResult> {
    return this.collaborators.daemonShutdown.waitForStop(pid, timeout, expectedGeneration);
  }

  private isProcessRunning(pid: number): boolean {
    return this.collaborators.daemonShutdown.isProcessRunning(pid);
  }

  private isRecordedDaemonRunning(
    record: {
      pid: number;
    } & ProcessGenerationRecordFields,
  ): boolean {
    return this.collaborators.daemonShutdown.isRecordedDaemonRunning(record);
  }

  getPid(): number | null {
    return this.collaborators.daemonShutdown.getPid();
  }

  private readonly collaborators = this.createCollaborators();

  private createCollaborators() {
    const host = this.collaboratorHost();
    return {
      daemonProcessDiscovery: new DaemonProcessDiscovery(host),
      daemonStartupLock: new DaemonStartupLock(host),
      daemonStart: new DaemonStart(host),
      daemonLaunch: new DaemonLaunch(host),
      daemonControlRecovery: new DaemonControlRecovery(host),
      daemonShutdown: new DaemonShutdown(host),
      daemonIdentityRecovery: new DaemonIdentityRecovery(host),
      daemonRestartCoordinator: new DaemonRestartCoordinator(host),
      daemonReadiness: new DaemonReadiness(host),
    };
  }

  /** Read dependencies on each use so replaceable test seams stay live. */
  private collaboratorHost(): DaemonManagerHost {
    const manager = this;
    let takeoverDeferrals: DefaultTakeoverDeferralLedger | undefined;
    return {
      ...this.collaboratorOperations(),
      get takeoverDeferrals() {
        return (takeoverDeferrals ??= new DefaultTakeoverDeferralLedger(
          new FileStartupFailureStore(`${manager.pidFilePath}.takeover-deferral.json`),
        ));
      },
      get pidFilePath() {
        return manager.pidFilePath;
      },
      get processFinder() {
        return manager.processFinder;
      },
      get socketPath() {
        return manager.socketPath;
      },
      get identityRecoveryIO() {
        return manager.identityRecoveryIO;
      },
      get retryExecutor() {
        return manager.retryExecutor;
      },
      get portAvailabilityChecker() {
        return manager.portAvailabilityChecker;
      },
      get lockFilePath() {
        return manager.lockFilePath;
      },
      get lockOwnerGenerationProbe() {
        return manager.lockOwnerGenerationProbe;
      },
      get startupLockOwnerToken() {
        return manager.startupLockOwnerToken;
      },
      get heldLockLogPath() {
        return manager.heldLockLogPath;
      },
      get timer() {
        return manager.timer;
      },
      get seams() {
        return manager.seams;
      },
      get launcher() {
        return manager.launcher;
      },
      get fallbackLauncher() {
        return manager.fallbackLauncher;
      },
      get extractionCleaner() {
        return manager.extractionCleaner;
      },
      get recoveryOwner() {
        return manager.recoveryOwner;
      },
      get launchCommandResolver() {
        return manager.launchCommandResolver;
      },
      get processSignaler() {
        return manager.processSignaler;
      },
      get processLivenessChecker() {
        return manager.processLivenessChecker;
      },
      get peerSocketReachability() {
        return manager.peerSocketReachability;
      },
      get platform() {
        return manager.platform;
      },
    };
  }

  /** Preserve virtual dispatch through manager delegates for spies and subclasses. */
  private collaboratorOperations(): DaemonManagerOperations {
    return {
      findLiveDaemonProcessRecords: (...args) => this.findLiveDaemonProcessRecords(...args),
      hasNamespaceRecordOrMarker: (...args) => this.hasNamespaceRecordOrMarker(...args),
      findAllDaemonProcesses: (...args) => this.findAllDaemonProcesses(...args),
      isProcessRunning: (...args) => this.isProcessRunning(...args),
      recordedStatus: (...args) => this.recordedStatus(...args),
      matchesRecordedDaemonGeneration: (...args) => this.matchesRecordedDaemonGeneration(...args),
      probeNamespaceOwner: (...args) => this.probeNamespaceOwner(...args),
      remainingTime: (...args) => this.remainingTime(...args),
      findNamespaceDaemonProcessRecords: (...args) =>
        this.findNamespaceDaemonProcessRecords(...args),
      daemonLaunchLogPath: (...args) => this.daemonLaunchLogPath(...args),
      readStartupLockHolder: (...args) => this.readStartupLockHolder(...args),
      throwIfRecoveryCancelled: (...args) => this.throwIfRecoveryCancelled(...args),
      getLockHolderStartupLogPath: (...args) => this.getLockHolderStartupLogPath(...args),
      acquireLock: (...args) => this.acquireLock(...args),
      startUnlocked: (...args) => this.startUnlocked(...args),
      releaseLock: (...args) => this.releaseLock(...args),
      createLockHolderStartupFailure: (...args) => this.createLockHolderStartupFailure(...args),
      readSettledStartupLockHolder: (...args) => this.readSettledStartupLockHolder(...args),
      waitForReady: (...args: Parameters<DaemonManager["waitForReady"]>) =>
        this.waitForReady(...args),
      sleepUnlessAborted: (...args) => this.sleepUnlessAborted(...args),
      socketPathObservable: (...args) => this.socketPathObservable(...args),
      verifyDaemonConnection: (...args) => this.verifyDaemonConnection(...args),
      authenticateSocketOwner: (...args) => this.authenticateSocketOwner(...args),
      hasPublishedRecoveryIdentity: (...args) => this.hasPublishedRecoveryIdentity(...args),
      describeError: (...args) => this.describeError(...args),
      startByAwaitingLockHolder: (...args) => this.startByAwaitingLockHolder(...args),
      start: (...args) => this.start(...args),
      lifecycleStatus: (...args) => this.lifecycleStatus(...args),
      verifyDaemonGenerationBeforeSignal: (...args) =>
        this.verifyDaemonGenerationBeforeSignal(...args),
      daemonProcessRecordFromStatus: (...args) => this.daemonProcessRecordFromStatus(...args),
      waitForExistingDaemon: (...args) => this.waitForExistingDaemon(...args),
      startIdentityRecovery: (...args) => this.startIdentityRecovery(...args),
      prepareDaemonForConditionalRestart: (...args) =>
        this.prepareDaemonForConditionalRestart(...args),
      stopRunningDaemon: (...args) => this.stopRunningDaemon(...args),
      assertNoSurvivingDaemonBeforeRestart: (...args) =>
        this.assertNoSurvivingDaemonBeforeRestart(...args),
      findLiveDaemonProcessesForStart: (...args) => this.findLiveDaemonProcessesForStart(...args),
      inheritExitSettings: (...args) => this.inheritExitSettings(...args),
      withDaemonOptions: (...args) => this.withDaemonOptions(...args),
      resolveLaunchCommand: (...args) => this.resolveLaunchCommand(...args),
      daemonLaunchEnvironment: (...args) => this.daemonLaunchEnvironment(...args),
      launchWithExtractionRetry: (...args) => this.launchWithExtractionRetry(...args),
      tryJoinPeerDaemonAfterSpawnExit: (...args) => this.tryJoinPeerDaemonAfterSpawnExit(...args),
      isLaunchedProcessReady: (...args) => this.isLaunchedProcessReady(...args),
      createDaemonExitFailure: (...args) => this.createDaemonExitFailure(...args),
      remainingRecoveryTime: (...args) => this.remainingRecoveryTime(...args),
      recoveryOptions: (...args) => this.recoveryOptions(...args),
      stopUnrecordedDaemonProcess: (...args) => this.stopUnrecordedDaemonProcess(...args),
      status: (...args) => this.status(...args),
      removeConfirmedDeadPidFile: (...args) => this.removeConfirmedDeadPidFile(...args),
      waitForStop: (...args) => this.waitForStop(...args),
      cleanupSocketPaths: (...args) => this.cleanupSocketPaths(...args),
      isRecordedDaemonRunning: (...args) => this.isRecordedDaemonRunning(...args),
      awaitRestartCleanup: (...args) => this.awaitRestartCleanup(...args),
      matchesObservedDaemonGeneration: (...args) => this.matchesObservedDaemonGeneration(...args),
      isConfirmedDifferentDaemonGeneration: (...args) =>
        this.isConfirmedDifferentDaemonGeneration(...args),
      recoverSocketIdentity: (...args) => this.recoverSocketIdentity(...args),
      isRecoveryOwner: (...args) => this.isRecoveryOwner(...args),
      markStartupLockRecovering: (...args) => this.markStartupLockRecovering(...args),
      restart: (...args) => this.restart(...args),
      isSameDaemonGeneration: (...args) => this.isSameDaemonGeneration(...args),
      replaceRecoveryOwner: (...args) => this.replaceRecoveryOwner(...args),
      createClient: (...args) => this.createClient(...args),
      stop: (...args) => this.stop(...args),
      stopNamespaceOrphansForExplicitRestart: (...args) =>
        this.stopNamespaceOrphansForExplicitRestart(...args),
      cleanupAcceptanceRestartFiles: (...args) => this.cleanupAcceptanceRestartFiles(...args),
      prepareIdentityRecoveryRestart: (...args) => this.prepareIdentityRecoveryRestart(...args),
      admitMaintenanceRestart: (...args) => this.admitMaintenanceRestart(...args),
      startWithRunningOptions: (...args) => this.startWithRunningOptions(...args),
      isIsolatedSocketNamespace: (...args) => this.isIsolatedSocketNamespace(...args),
    };
  }
}

const defaultDaemonProcessSignaler: DaemonProcessSignaler = {
  signal(pid, signal): void {
    process.kill(pid, signal);
  },
};

function hasProcessLivenessChecker(value: unknown): value is DaemonProcessLivenessChecker {
  return (
    typeof (value as Partial<DaemonProcessLivenessChecker> | undefined)?.isProcessRunning ===
    "function"
  );
}

export type DaemonStartResult = "started" | "joined" | "replaced";

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
 * Daemon Manager
 *
 * Handles daemon lifecycle:
 * - Start daemon in background
 * - Stop daemon gracefully
 * - Check daemon status
 * - Restart daemon
 */
function isTcpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

export async function runDaemonCommand(
  command: string,
  args: string[],
  options: RunDaemonCommandOptions = {},
): Promise<void> {
  return runDaemonCommandWithManager(command, args, options, DaemonManager);
}

function resolveDaemonManagerOptions(options: DaemonManagerOptions) {
  const paths = resolveDaemonManagerPaths(options);
  const {
    extractionCleaner = fileSystemExtractionCleaner,
    processSignaler = defaultDaemonProcessSignaler,
    idGenerator = defaultIdGenerator,
    platform = process.platform,
    portAvailabilityChecker = new NetDaemonPortAvailabilityChecker(),
    retryExecutor = new DefaultRetryExecutor(paths.timer),
    lockOwnerGenerationProbe = defaultLockOwnerGenerationProbe,
  } = options;
  return {
    ...options,
    ...paths,
    extractionCleaner,
    processSignaler,
    idGenerator,
    platform,
    portAvailabilityChecker,
    retryExecutor,
    lockOwnerGenerationProbe,
  };
}

function resolveDaemonManagerPaths(options: DaemonManagerOptions) {
  const {
    stateProvider = () => daemonStateLikeFrom(defaultDaemonContext),
    timer = defaultTimer,
    lockFilePath = LOCK_FILE_PATH,
    pidFilePath = PID_FILE_PATH,
    socketPath = SOCKET_PATH,
    processFinder = createDefaultDaemonProcessFinder(),
  } = options;
  return { stateProvider, timer, lockFilePath, pidFilePath, socketPath, processFinder };
}
