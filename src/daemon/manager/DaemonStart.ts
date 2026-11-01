import type { DaemonManagerSeams } from "../managerTestInternals";
import {
  consumeDaemonExitRecord,
  removeDaemonExitRecord,
  resolveDaemonExitOptions,
  DAEMON_EXIT_RECORD_TTL_MS,
} from "../daemonExitRecord";
import { basename, isAbsolute } from "node:path";
import { devNull } from "node:os";
import { logger, resolveAutomobileLogSink } from "../../utils/logger";
import { resolveDaemonInstallSpecifier } from "../../constants/release";
import { assertUnitTestLogsDirIsolated, ensureSecureLogsDirSync } from "../../utils/tempDir";
import { ActionableError } from "../../models";
import {
  DAEMON_LAUNCH_LOG_PATH_ENV,
  DAEMON_STARTUP_TIMEOUT_MS,
  DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  DAEMON_RESTART_HANDOFF_DELAY_MS,
  DAEMON_VERSION,
  resolveDaemonVersion,
  syncSettledDaemonVersion,
  DAEMON_VERSION_RESTART_COOLDOWN_MS,
} from "../wire/constants";
import { DaemonStatus, DaemonOptions } from "../types";
import {
  DaemonRestartDeferredError,
  type DaemonRestartPreparation,
} from "../daemonRestartAdmission";
import { Timer } from "../../utils/SystemTimer";
import {
  clearDaemonLaunchLogOwnerTombstoneSync,
  shouldProtectLiveDaemonVersion,
} from "../daemonFiles";
import { type DaemonLaunchCommand } from "../DaemonLauncher";
import { daemonProcessOptions } from "../daemonOptionScopes";
import { type DaemonProcessRecord } from "../processTable";
import { stderrLog } from "./DaemonLaunch";
import type { DaemonStartResult } from "../manager";
import {
  deferredRestartError,
  type TakeoverDeferralKind,
  type TakeoverDeferralLedger,
} from "./TakeoverDeferralLedger";

/** Only the replaceable manager seams used by DaemonStart. */
export interface DaemonStartHost {
  acquireLock(): boolean;
  startByAwaitingLockHolder(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    onTakeover?: () => Promise<DaemonStartResult>,
  ): Promise<DaemonStartResult>;
  startUnlocked(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    inheritExitRecord?: boolean,
  ): Promise<DaemonStartResult>;
  releaseLock(): void;
  start(options?: DaemonOptions): Promise<DaemonStartResult>;
  readonly socketPath: string;
  readonly seams: DaemonManagerSeams;
  readonly timer: Timer;
  readonly takeoverDeferrals: TakeoverDeferralLedger;
  lifecycleStatus(): Promise<DaemonStatus>;
  throwIfRecoveryCancelled(signal: AbortSignal | undefined): void;
  verifyDaemonGenerationBeforeSignal(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    context?: string,
  ): Promise<boolean>;
  daemonProcessRecordFromStatus(status: DaemonStatus): DaemonProcessRecord;
  probeNamespaceOwner(): Promise<DaemonStatus | undefined>;
  waitForExistingDaemon(timeout: number): Promise<boolean>;
  remainingTime(deadline: number): number;
  startIdentityRecovery(status: DaemonStatus): Promise<DaemonStartResult>;
  prepareDaemonForConditionalRestart(expected: DaemonStatus): Promise<DaemonRestartPreparation>;
  stopRunningDaemon(status: DaemonStatus, timeout?: number, signalFirst?: boolean): Promise<void>;
  assertNoSurvivingDaemonBeforeRestart(
    options: DaemonOptions,
    recoveryDeadline?: number,
  ): Promise<void>;
  findLiveDaemonProcessesForStart(options: DaemonOptions, startDeadline: number): Promise<number[]>;
  inheritExitSettings(options: DaemonOptions): Promise<DaemonOptions>;
  withDaemonOptions(launch: DaemonLaunchCommand, options: DaemonOptions): DaemonLaunchCommand;
  resolveLaunchCommand(): DaemonLaunchCommand;
  daemonLaunchEnvironment(options: DaemonOptions): NodeJS.ProcessEnv;
  readonly heldLockLogPath: string | undefined;
  daemonLaunchLogPath(): string;
  launchWithExtractionRetry(
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
  ): Promise<void>;
  tryJoinPeerDaemonAfterSpawnExit(budgetMs: number): Promise<boolean>;
}

/** Daemon Start lifecycle operations. */
export class DaemonStart {
  private readonly runningRestartOptions = new WeakSet<DaemonOptions>();
  constructor(private readonly host: DaemonStartHost) {}
  /**
   * Start the daemon in background (detached process).
   * Uses an atomic file lock to prevent thundering herd when multiple
   * proxy processes try to start the daemon simultaneously.
   */
  async start(options: DaemonOptions = {}): Promise<DaemonStartResult> {
    const inheritExitRecord = !this.runningRestartOptions.has(options);
    if (!this.host.acquireLock()) {
      return await this.host.startByAwaitingLockHolder(options, undefined, () =>
        this.host.startUnlocked(options, undefined, inheritExitRecord),
      );
    }

    try {
      return await this.host.startUnlocked(options, undefined, inheritExitRecord);
    } finally {
      this.host.releaseLock();
    }
  }

  /** Keep virtual start() dispatch while scoping the running-options policy to this request. */
  async startWithRunningOptions(options: DaemonOptions): Promise<DaemonStartResult> {
    this.runningRestartOptions.add(options);
    try {
      return await this.host.start(options);
    } finally {
      this.runningRestartOptions.delete(options);
    }
  }

  /** Restore startup policy after a self-exit on this control socket. */
  async inheritExitSettings(options: DaemonOptions): Promise<DaemonOptions> {
    const record = consumeDaemonExitRecord(
      this.host.socketPath,
      this.host.seams.exitRecordFileSystem,
    );
    const resolution = resolveDaemonExitOptions(options, record, this.host.timer.now(), {
      ttl: DAEMON_EXIT_RECORD_TTL_MS,
      buildId: this.host.seams.currentBuildId(),
    });
    if (resolution.outcome === "stale" || resolution.outcome === "build-mismatch") {
      logger.info(`Ignoring daemon exit record: ${resolution.outcome}`);
    }
    if (resolution.outcome !== "inherited" || !record) {
      return resolution.options;
    }
    const inherited = resolution.options;
    let portNote = "";
    if (resolution.inheritedPort && inherited.port !== undefined) {
      // A stolen predecessor port must not wedge every auto-start (#11074).
      inherited.strictPort = await this.host.seams.portFreeProbe(inherited.port);
      if (!inherited.strictPort) {
        portNote = "; previous port is busy, binding without strictness";
      }
    }
    const flags = Object.entries(inherited)
      .filter(([key]) => key !== "port")
      .map(([key, value]) =>
        value === true
          ? key
          : `${key}=${JSON.stringify(typeof value === "string" && isAbsolute(value) ? basename(value) : value)}`,
      )
      .join(" ");
    stderrLog(
      `Inheriting daemon port ${inherited.port ?? "default"} after ${record.reason}; flags: ${flags || "none"}${portNote}`,
    );
    return inherited;
  }

  /**
   * Internal start implementation. REQUIRES the caller to already hold the
   * daemon start lock (every in-class caller does); calling it without the lock
   * races concurrent starts. Production code outside this class must use
   * {@link start}/{@link restart}.
   *
   * Not `private` only so tests can `spyOn` it to stub the launch step.
   *
   * @internal
   */
  async startUnlocked(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    inheritExitRecord: boolean = true,
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
    const startDeadline = this.host.timer.now() + DAEMON_STARTUP_TIMEOUT_MS;
    if (!syncSettledDaemonVersion()) {
      await resolveDaemonVersion();
    }
    const admission = await this.admitStart(
      options,
      recoverySignal,
      inheritExitRecord,
      startDeadline,
    );
    if ("done" in admission) {
      return admission.done;
    }
    return this.launchDaemon(
      admission.options,
      admission.inheritExitRecord,
      startDeadline,
      recoverySignal,
    );
  }

  /**
   * Phase 1 of {@link startUnlocked}: decide whether this start is already satisfied (joined a live
   * or peer daemon, recovered an identity) or must launch one, taking over a strictly older daemon
   * first. Returns the final result, or the options and exit-record policy to launch with.
   */
  private async admitStart(
    options: DaemonOptions,
    recoverySignal: AbortSignal | undefined,
    inheritExitRecord: boolean,
    startDeadline: number,
  ): Promise<{ done: DaemonStartResult } | { options: DaemonOptions; inheritExitRecord: boolean }> {
    let status = await this.host.lifecycleStatus();
    this.host.throwIfRecoveryCancelled(recoverySignal);
    if (
      status.running &&
      !(await this.host.verifyDaemonGenerationBeforeSignal(
        this.host.daemonProcessRecordFromStatus(status),
        undefined,
        "Daemon start",
      ))
    ) {
      status = { running: false };
    }
    if (!status.running && status.recovery) {
      return { done: await this.recoverOrJoinNamespaceIdentity(status, startDeadline) };
    }
    if (status.running) {
      const takeover = await this.takeOverOlderDaemon(status, options);
      if ("done" in takeover) {
        return takeover;
      }
      options = takeover.options;
      // This takeover already has the running generation's authoritative options.
      inheritExitRecord = false;
    }

    if (await this.joinLiveDaemonWithoutRecord(options, startDeadline, recoverySignal)) {
      return { done: "joined" };
    }
    return { options, inheritExitRecord };
  }

  /** A stopped daemon with recovery evidence: reuse an old answering owner, or recover the identity. */
  private async recoverOrJoinNamespaceIdentity(
    status: DaemonStatus,
    startDeadline: number,
  ): Promise<DaemonStartResult> {
    const owner =
      status.recovery?.state === "unauthenticated"
        ? await this.host.probeNamespaceOwner()
        : undefined;
    // Older socket owners lack identity-republication fields. Reuse their
    // answering namespace socket without granting permission to signal them.
    if (
      owner?.reportedSocketPath === undefined &&
      owner?.reportedPidFilePath === undefined &&
      owner?.pid !== undefined &&
      (await this.host.waitForExistingDaemon(
        Math.min(DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS, this.host.remainingTime(startDeadline)),
      ))
    ) {
      return "joined";
    }
    return this.host.startIdentityRecovery(status);
  }

  /**
   * Stop a strictly older live daemon so this start can replace it, unless it must be left alone
   * (version protected, in cooldown, or another restart owns it). Returns the options to launch
   * with, or the final result when the start is already satisfied.
   */
  private async takeOverOlderDaemon(
    status: DaemonStatus,
    options: DaemonOptions,
  ): Promise<{ done: DaemonStartResult } | { options: DaemonOptions }> {
    // ensureVersionMatches/compareStrictNumericVersions treat empty/unparseable as older (+Infinity); this start guard deliberately protects it.
    if (shouldProtectLiveDaemonVersion(status.version, DAEMON_VERSION)) {
      stderrLog(`Daemon is already running (PID ${status.pid}, port ${status.port})`);
      return { done: "joined" };
    }
    if (status.startedAt) {
      const daemonAgeMs = this.host.timer.now() - status.startedAt;
      if (daemonAgeMs < DAEMON_VERSION_RESTART_COOLDOWN_MS) {
        logger.warn(
          `[DaemonManager] Skipping strictly-older daemon takeover due to cooldown: daemon ${status.version} is ${daemonAgeMs}ms old, current version is ${DAEMON_VERSION}`,
        );
        throw new DaemonRestartDeferredError("restart is in cooldown");
      }
    }

    if (!(await this.prepareOlderDaemonRestart(status))) {
      return { done: "joined" };
    }
    this.host.takeoverDeferrals.clear();

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
    await this.host.stopRunningDaemon(status, DAEMON_SHUTDOWN_TIMEOUT_MS, false);
    // This takeover already has the running generation's authoritative options.
    await this.host.assertNoSurvivingDaemonBeforeRestart(options);
    await this.host.timer.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);

    return { options };
  }

  /** Admission failures only accumulate diagnostics; they never authorize stopping the incumbent. */
  private async prepareOlderDaemonRestart(status: DaemonStatus): Promise<boolean> {
    let preparation: DaemonRestartPreparation;
    try {
      preparation = await this.host.prepareDaemonForConditionalRestart(status);
    } catch (error) {
      if (error instanceof DaemonRestartDeferredError) {
        this.deferOlderDaemonTakeover(status, "unavailable", error);
      }
      throw error;
    }
    if (preparation.accepted) {
      return true;
    }
    if (preparation.reason === "generation_changed" || preparation.reason === "restart_pending") {
      stderrLog("Daemon restart is already in progress; joining its successor");
      return false;
    }
    const kind = preparation.reason === "active_operations" ? "active_operations" : "unavailable";
    const reason =
      preparation.reason === "active_operations"
        ? "a device operation is active"
        : preparation.reason === "shutdown_unavailable"
          ? "the daemon could not initiate its own shutdown"
          : "the daemon returned an unrecognized safe-restart admission result";
    this.deferOlderDaemonTakeover(status, kind, new DaemonRestartDeferredError(reason));
  }

  private deferOlderDaemonTakeover(
    status: DaemonStatus,
    kind: TakeoverDeferralKind,
    original: DaemonRestartDeferredError,
  ): never {
    throw deferredRestartError({
      ledger: this.host.takeoverDeferrals,
      incumbent: status,
      kind,
      original,
      nowMs: this.host.timer.now(),
      subject: "older daemon",
    });
  }

  /**
   * A missing or stale PID record must not turn an ordinary start into permission to terminate a
   * live daemon. True when a live daemon without a usable record became reachable and is reused;
   * throws when one is live but never becomes reachable; false when none is live.
   */
  private async joinLiveDaemonWithoutRecord(
    options: DaemonOptions,
    startDeadline: number,
    recoverySignal: AbortSignal | undefined,
  ): Promise<boolean> {
    // A missing or stale PID record must not turn an ordinary start request into
    // permission to terminate a live daemon. This happens when a second client
    // reaches the shared socket during a long-running tool call and races a
    // transient availability probe. Reuse a responsive daemon; require an
    // explicit restart for a live but unreachable process.
    const liveDaemons = await this.host.findLiveDaemonProcessesForStart(options, startDeadline);
    this.host.throwIfRecoveryCancelled(recoverySignal);
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
        this.host.remainingTime(startDeadline),
      );
      const existingDaemonReady = await this.host.waitForExistingDaemon(existingDaemonWaitBudget);
      this.host.throwIfRecoveryCancelled(recoverySignal);
      if (existingDaemonReady) {
        stderrLog("Reusing existing responsive daemon");
        return true;
      }

      throw new ActionableError(
        `Found live AutoMobile daemon process(es) (${liveDaemons.join(", ")}) but none became reachable within ` +
          `${existingDaemonWaitBudget}ms. Refusing to terminate a live daemon during start; ` +
          `inspect it or run \`bunx ${resolveDaemonInstallSpecifier()} --daemon restart\` explicitly.`,
      );
    }
    return false;
  }

  /** Phase 2 of {@link startUnlocked}: spawn the daemon, wait for it, and rejoin a racing peer. */
  private async launchDaemon(
    options: DaemonOptions,
    inheritExitRecord: boolean,
    startDeadline: number,
    recoverySignal: AbortSignal | undefined,
  ): Promise<DaemonStartResult> {
    // Do not pre-emptively remove namespace files here. The lock serializes
    // cooperative managers, but a direct daemon may still own a socket which
    // this manager cannot prove stale. The child uses the shared bind guard to
    // reclaim only a socket with an unreachable listener and a positively-dead
    // recorded owner; it publishes its own early PID record before that bind.

    if (inheritExitRecord) {
      options = await this.host.inheritExitSettings(options);
    } else {
      removeDaemonExitRecord(this.host.socketPath, this.host.seams.exitRecordFileSystem);
    }
    stderrLog("Starting AutoMobile daemon...");

    // Resolve the current binary so the daemon uses the same version.
    // process.argv[1] is the entry script (e.g. dist/src/index.js).
    // Falls back to bunx to avoid requiring a global install.
    const launchCommand = this.host.withDaemonOptions(this.host.resolveLaunchCommand(), options);

    // Redirect the detached daemon's stdout/stderr into the configured logs dir
    // (`~/.auto-mobile/logs` by default) rather than an ephemeral
    // `mkdtemp(tmpdir())` directory. Under bunx the temp tree is reaped while the
    // daemon keeps this fd open, which previously left the on-disk log unlinked
    // and post-hoc debugging impossible (issue #2724). The logs dir is created
    // owner-only (0o700) by ensureSecureLogsDirSync, so a fixed, predictable
    // filename inside it is not exposed to other users.
    // Propagate any non-default file paths to the child so its constants module
    // resolves to the same locations this manager polls.
    const childEnv = this.host.daemonLaunchEnvironment(options);
    const logSink = resolveAutomobileLogSink(childEnv);
    const capturesLaunchOutput = logSink !== "stderr";
    const logPath = capturesLaunchOutput
      ? (this.host.heldLockLogPath ?? this.host.daemonLaunchLogPath())
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
    const logFd = this.host.seams.launchLogFileSystem.openSync(logPath, "w", 0o600);

    try {
      await this.host.launchWithExtractionRetry(
        { options, childEnv, logSink, capturesLaunchOutput, logFd, logPath },
        launchCommand,
        startDeadline,
        recoverySignal,
      );
    } catch (error) {
      this.host.throwIfRecoveryCancelled(recoverySignal);
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
        this.host.remainingTime(startDeadline) - PEER_DAEMON_JOIN_DELIVERY_HEADROOM_MS,
      );
      if (rejoinBudget > 0 && (await this.host.tryJoinPeerDaemonAfterSpawnExit(rejoinBudget))) {
        stderrLog(
          "A peer daemon became ready on the shared socket after our launch exited; joining it",
        );
        return "joined";
      }
      throw error;
    } finally {
      // Close our reference to the log file (daemon process still has it open)
      this.host.seams.launchLogFileSystem.closeSync(logFd);
    }

    const newStatus = await this.host.lifecycleStatus();
    stderrLog(`Daemon started successfully (PID ${newStatus.pid}, port ${newStatus.port})`);
    stderrLog(`Socket: ${newStatus.socketPath}`);
    stderrLog(`Logs: ${logPath}`);
    return "started";
  }
}

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
