import { type IdentityRecoveryIO } from "../identityRecovery";
import type { DaemonManagerSeams } from "../managerTestInternals";
import { errorMessage } from "../../utils/describeUnknownError";
import { removeDaemonExitRecord } from "../daemonExitRecord";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { logger } from "../../utils/logger";
import { ActionableError } from "../../models";
import {
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  DAEMON_FORCED_STOP_TIMEOUT_MS,
  DEFAULT_DAEMON_PORT,
} from "../wire/constants";
import { DaemonStatus, PidFileData, DaemonOptions } from "../types";
import { Timer } from "../../utils/SystemTimer";
import { cleanupDaemonFiles, isConfirmedRecycledProcess } from "../daemonFiles";
import { recordProvesFormerSocketOwner } from "../incumbentOwnerGuard";
import {
  recordedProcessGenerationToken,
  type ProcessGenerationRecordFields,
} from "../processGenerationFields";
import {
  DAEMON_SOCKET_PATH_FLAG,
  type DaemonProcessLivenessChecker,
  type DaemonProcessRecord,
  type DaemonProcessSignaler,
} from "../processTable";
import { type DaemonPortAvailabilityChecker } from "../portAvailability";
import { DaemonGenerationExitedBeforeSignalError } from "../DaemonGenerationExitedBeforeSignalError";
import { stderrLog } from "./DaemonLaunch";
import { DEFAULT_DAEMON_HOST } from "./DaemonProcessDiscovery";

/** Only the replaceable manager seams used by DaemonShutdown. */
export interface DaemonShutdownHost {
  status(recoverIdentity?: boolean): Promise<DaemonStatus>;
  readonly identityRecoveryIO: IdentityRecoveryIO;
  authenticateSocketOwner(): Promise<DaemonStatus>;
  readonly socketPath: string;
  removeConfirmedDeadPidFile(): Promise<void>;
  readonly seams: DaemonManagerSeams;
  stopRunningDaemon(status: DaemonStatus, timeout?: number, signalFirst?: boolean): Promise<void>;
  daemonProcessRecordFromStatus(status: DaemonStatus): DaemonProcessRecord;
  waitForStop(
    pid: number,
    timeout: number,
    expectedGeneration?: DaemonProcessRecord,
  ): Promise<WaitForStopResult>;
  readonly pidFilePath: string;
  cleanupSocketPaths(primarySocketPath?: string): string[] | undefined;
  verifyDaemonGenerationBeforeSignal(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    context?: string,
  ): Promise<boolean>;
  readonly processSignaler: DaemonProcessSignaler;
  isRecordedDaemonRunning(
    record: {
      pid: number;
    } & ProcessGenerationRecordFields,
  ): boolean;
  readonly timer: Timer;
  acquireLock(): boolean;
  remainingTime(deadline: number): number;
  releaseLock(): void;
  findNamespaceDaemonProcessRecords(timeoutMs?: number): Promise<DaemonProcessRecord[]>;
  remainingRecoveryTime(recoveryDeadline: number | undefined): number | undefined;
  readonly portAvailabilityChecker: DaemonPortAvailabilityChecker;
  awaitRestartCleanup(operations: ReadonlyArray<() => void | Promise<void>>): Promise<void>;
  throwIfRecoveryCancelled(signal: AbortSignal | undefined): void;
  describeError(error: unknown): string;
  isProcessRunning(pid: number): boolean;
  findLiveDaemonProcessRecords(timeoutMs?: number): DaemonProcessRecord[];
  hasNamespaceRecordOrMarker(candidate: DaemonProcessRecord): boolean;
  probeNamespaceOwner(): Promise<DaemonStatus | undefined>;
  matchesObservedDaemonGeneration(
    expected: DaemonProcessRecord,
    candidate: DaemonProcessRecord,
  ): boolean;
  isConfirmedDifferentDaemonGeneration(
    expected: DaemonProcessRecord,
    candidate: DaemonProcessRecord,
  ): boolean;
  readonly processLivenessChecker: DaemonProcessLivenessChecker;
}

/** Daemon Shutdown lifecycle operations. */
export class DaemonShutdown {
  constructor(private readonly host: DaemonShutdownHost) {}
  /**
   * Stop the daemon gracefully
   */
  async stop(timeout: number = DAEMON_SHUTDOWN_TIMEOUT_MS, expected?: DaemonStatus): Promise<void> {
    // Explicit stop must not repair or replace a missing generation before stopping it.
    let status = expected ?? (await this.host.status(false));
    if (!status.running && this.host.identityRecoveryIO.socketExists()) {
      status = await this.host.authenticateSocketOwner();
    }

    if (!status.running && status.recovery) {
      // A process holds this namespace's socket but is not provably its daemon (#11252):
      // nothing was stopped, so this must not read as a clean "not running".
      throw new ActionableError(
        `Daemon socket ${this.host.socketPath} is held by a process that could not be authenticated ` +
          `as this namespace's daemon (${status.recovery.state}` +
          `${status.recovery.reason ? `: ${status.recovery.reason}` : ""}); nothing was stopped. ` +
          "Run --daemon diagnose to identify the socket owner.",
      );
    }

    if (!status.running) {
      // Status never deletes files (issue #6140) and does not
      // reclaim a well-formed PID file naming an already-exited daemon.
      // `stop()` is a deliberate, explicit user action, so it is safe to
      // remove that CONFIRMED-DEAD daemon's PID FILE here — but NOT its
      // socket pathname (see removeConfirmedDeadPidFile for why).
      await this.host.removeConfirmedDeadPidFile();
      removeDaemonExitRecord(this.host.socketPath, this.host.seams.exitRecordFileSystem);
      stderrLog("Daemon is not running");
      return;
    }

    await this.host.stopRunningDaemon(status, timeout);
    removeDaemonExitRecord(this.host.socketPath, this.host.seams.exitRecordFileSystem);
  }

  /**
   * Stop the exact generation already observed by the caller. Keeping this
   * snapshot through the signal closes the stale-restart gap where a second
   * status read could target a successor that another client just started.
   *
   * Public so tests can stub the stop step.
   */
  async stopRunningDaemon(
    status: DaemonStatus,
    timeout: number = DAEMON_SHUTDOWN_TIMEOUT_MS,
    signalFirst: boolean = true,
  ): Promise<void> {
    this.assertDaemonStatusNamespace(status);
    stderrLog(`Stopping daemon (PID ${status.pid})...`);

    const pid = status.pid!;
    const expected = this.host.daemonProcessRecordFromStatus(status);

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
      let waitResult = await this.host.waitForStop(pid, timeout, expected);
      let replacedByOtherGeneration = waitResult.replacedByOtherGeneration;

      if (!waitResult.stopped) {
        stderrLog(`Daemon did not stop gracefully, sending SIGKILL...`);
        await this.signalVerifiedDaemonGeneration(
          expected,
          "SIGKILL",
          `Daemon generation ${pid} exited before stop could force-stop it.`,
        );

        waitResult = await this.host.waitForStop(pid, DAEMON_FORCED_STOP_TIMEOUT_MS, expected);
        replacedByOtherGeneration ||= waitResult.replacedByOtherGeneration;
        if (!waitResult.stopped) {
          throw new ActionableError(`Daemon process ${pid} did not exit after SIGKILL`);
        }
      }

      if (!replacedByOtherGeneration) {
        await cleanupDaemonFiles({
          pidFilePath: this.host.pidFilePath,
          socketPaths: this.host.cleanupSocketPaths(status.socketPath),
          expectedPid: pid,
        });
      }

      stderrLog("Daemon stopped");
    } catch (error) {
      await this.handleStopRunningDaemonError(error, status, pid);
    }
  }

  daemonProcessRecordFromStatus(status: DaemonStatus): DaemonProcessRecord {
    return {
      pid: status.pid!,
      ppid: 0,
      command: status.entryScript ?? "",
      startedAt: status.processStartedAt ?? status.startedAt,
      processGenerationToken: recordedProcessGenerationToken(status),
    };
  }

  private assertDaemonStatusNamespace(status: DaemonStatus): void {
    if (status.socketPath !== this.host.socketPath) {
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
    if (!(await this.host.verifyDaemonGenerationBeforeSignal(expected, undefined, "Daemon stop"))) {
      throw new DaemonGenerationExitedBeforeSignalError(exitedMessage);
    }
    this.host.processSignaler.signal(expected.pid, signal);
  }

  private async handleStopRunningDaemonError(
    error: unknown,
    status: DaemonStatus,
    pid: number,
  ): Promise<void> {
    if (error instanceof DaemonGenerationExitedBeforeSignalError) {
      // Liveness confirmed death; no signal or socket cleanup is needed.
      logger.debug("Recorded daemon generation died before signalling", error);
      await this.host.removeConfirmedDeadPidFile();
      stderrLog(error.message);
      return;
    }
    if (error instanceof Error && error.message.includes("ESRCH")) {
      await cleanupDaemonFiles({
        pidFilePath: this.host.pidFilePath,
        socketPaths: this.host.cleanupSocketPaths(status.socketPath),
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
    if (!existsSync(this.host.pidFilePath)) {
      return undefined;
    }
    try {
      const pidFileContent = await readFile(this.host.pidFilePath, "utf-8");
      const pidData: PidFileData = JSON.parse(pidFileContent);
      if (typeof pidData.pid !== "number" || this.host.isRecordedDaemonRunning(pidData)) {
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
    return this.host.identityRecoveryIO.socketExists() && recordProvesFormerSocketOwner(record);
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
  async removeConfirmedDeadPidFile(): Promise<void> {
    // Cheap unlocked pre-check: skip acquiring the lock entirely when there is
    // plainly nothing to clean up (already gone, or already live).
    const unlockedRecord = await this.readConfirmedDeadPidData();
    if (!unlockedRecord || this.mustKeepDeadRecordAsSocketOwnerProof(unlockedRecord)) {
      return;
    }

    const deadline = this.host.timer.now() + PID_FILE_DELETE_LOCK_ACQUIRE_TIMEOUT_MS;
    let acquired = this.host.acquireLock();
    while (!acquired && this.host.remainingTime(deadline) > 0) {
      await this.host.timer.sleep(
        Math.min(PID_FILE_DELETE_LOCK_POLL_MS, this.host.remainingTime(deadline)),
      );
      acquired = this.host.acquireLock();
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
        pidFilePath: this.host.pidFilePath,
        socketPaths: [], // NEVER the socket — see the doc comment above.
        expectedPid: pidData.pid,
      });
    } catch (error) {
      logger.warn(
        `Failed to remove a confirmed-dead PID file during stop(): ${errorMessage(error)}`,
      );
    } finally {
      this.host.releaseLock();
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
   *
   * Public so tests can stub the survivor check.
   */
  async assertNoSurvivingDaemonBeforeRestart(
    options: DaemonOptions,
    recoveryDeadline?: number,
  ): Promise<void> {
    const survivors = (
      await this.host.findNamespaceDaemonProcessRecords(
        this.host.remainingRecoveryTime(recoveryDeadline),
      )
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
      await this.host.portAvailabilityChecker.isPortFree(
        port,
        host,
        this.host.remainingRecoveryTime(recoveryDeadline),
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
  async stopNamespaceOrphansForExplicitRestart(recordedPid?: number): Promise<void> {
    const candidates = (await this.host.findNamespaceDaemonProcessRecords()).filter(
      (candidate) => candidate.pid !== recordedPid,
    );
    if (candidates.length === 0) {
      return;
    }

    stderrLog(
      `Explicit restart force-stopping ${candidates.length} live AutoMobile daemon candidate(s) without this namespace's PID record...`,
    );
    await this.host.awaitRestartCleanup(
      candidates.map((candidate) => () => this.stopExplicitRestartDaemonProcess(candidate)),
    );
  }

  async awaitRestartCleanup(operations: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
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
  async stopUnrecordedDaemonProcess(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!(await this.host.verifyDaemonGenerationBeforeSignal(expected, recoveryDeadline))) {
      stderrLog(`Daemon candidate ${expected.pid} exited before repair could stop it.`);
      return;
    }
    this.host.throwIfRecoveryCancelled(signal);

    stderrLog(
      `Repair stopping the verified daemon for this control namespace (PID ${expected.pid})...`,
    );
    try {
      this.host.processSignaler.signal(expected.pid, "SIGTERM");
    } catch (error) {
      if (this.isMissingProcessError(error)) {
        return;
      }
      throw new ActionableError(
        `Failed to stop verified daemon process ${expected.pid}: ${this.host.describeError(error)}`,
      );
    }

    if (
      (
        await this.host.waitForStop(
          expected.pid,
          this.stopWaitTimeout(DAEMON_SHUTDOWN_TIMEOUT_MS, recoveryDeadline),
          expected,
        )
      ).stopped
    ) {
      return;
    }

    stderrLog(`Verified daemon ${expected.pid} did not stop gracefully, sending SIGKILL...`);
    if (!(await this.host.verifyDaemonGenerationBeforeSignal(expected, recoveryDeadline))) {
      stderrLog(`Daemon candidate ${expected.pid} exited before repair could force-stop it.`);
      return;
    }
    this.host.throwIfRecoveryCancelled(signal);
    try {
      this.host.processSignaler.signal(expected.pid, "SIGKILL");
    } catch (error) {
      if (this.isMissingProcessError(error)) {
        return;
      }
      throw new ActionableError(
        `Failed to force-stop verified daemon process ${expected.pid}: ${this.host.describeError(error)}`,
      );
    }

    if (
      !(
        await this.host.waitForStop(
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
    if (
      !(await this.host.verifyDaemonGenerationBeforeSignal(expected, undefined, "Explicit restart"))
    ) {
      stderrLog(`Daemon candidate ${expected.pid} exited before explicit restart could stop it.`);
      return;
    }

    stderrLog(`Stopping daemon without this namespace's PID record (PID ${expected.pid})...`);
    try {
      this.host.processSignaler.signal(expected.pid, "SIGTERM");
    } catch (error) {
      if (this.isMissingProcessError(error)) {
        return;
      }
      throw new ActionableError(
        `Failed to stop verified daemon process ${expected.pid}: ${this.host.describeError(error)}`,
      );
    }

    if ((await this.host.waitForStop(expected.pid, DAEMON_SHUTDOWN_TIMEOUT_MS, expected)).stopped) {
      return;
    }

    stderrLog(`Verified daemon ${expected.pid} did not stop gracefully, sending SIGKILL...`);
    if (
      !(await this.host.verifyDaemonGenerationBeforeSignal(expected, undefined, "Explicit restart"))
    ) {
      stderrLog(
        `Daemon candidate ${expected.pid} exited before explicit restart could force-stop it.`,
      );
      return;
    }
    try {
      this.host.processSignaler.signal(expected.pid, "SIGKILL");
    } catch (error) {
      if (this.isMissingProcessError(error)) {
        return;
      }
      throw new ActionableError(
        `Failed to force-stop verified daemon process ${expected.pid}: ${this.host.describeError(error)}`,
      );
    }

    if (
      !(await this.host.waitForStop(expected.pid, DAEMON_FORCED_STOP_TIMEOUT_MS, expected)).stopped
    ) {
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
  async verifyDaemonGenerationBeforeSignal(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    context: string = "Daemon recovery",
  ): Promise<boolean> {
    if (!this.host.isProcessRunning(expected.pid)) {
      return false;
    }
    if (expected.startedAt === undefined && expected.processGenerationToken === undefined) {
      throw new ActionableError(
        `${context} could not verify the recorded daemon process generation before signalling it.`,
      );
    }
    const candidates = this.host.findLiveDaemonProcessRecords(
      this.host.remainingRecoveryTime(recoveryDeadline),
    );
    this.host.remainingRecoveryTime(recoveryDeadline);
    const current = candidates.find((candidate) => candidate.pid === expected.pid);
    this.assertObservedDaemonGeneration(expected, current, context);
    if (current && this.host.hasNamespaceRecordOrMarker(current)) {
      return this.host.isProcessRunning(expected.pid);
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
    const owner = await this.host.probeNamespaceOwner();
    this.host.remainingRecoveryTime(recoveryDeadline);
    if (!this.host.isProcessRunning(expected.pid)) {
      return false;
    }
    const refreshed = this.host
      .findLiveDaemonProcessRecords(this.host.remainingRecoveryTime(recoveryDeadline))
      .find((candidate) => candidate.pid === expected.pid);
    this.host.remainingRecoveryTime(recoveryDeadline);
    this.assertObservedDaemonGeneration(expected, refreshed, context);
    if (this.matchesSocketOwnerBeforeSignal(owner, expected, refreshed)) {
      return this.host.isProcessRunning(expected.pid);
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
    if (current && !this.host.matchesObservedDaemonGeneration(expected, current)) {
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
      (owner.reportedSocketPath !== this.host.socketPath ||
        owner.reportedPidFilePath !== this.host.pidFilePath)
    ) {
      return false;
    }
    if (current?.command.includes(DAEMON_SOCKET_PATH_FLAG)) {
      return false;
    }
    return this.host.matchesObservedDaemonGeneration(expected, {
      pid: owner.pid,
      ppid: 0,
      command: "",
      startedAt: owner.processStartedAt ?? owner.startedAt,
      processGenerationToken: recordedProcessGenerationToken(owner),
    });
  }

  private stopWaitTimeout(timeoutMs: number, recoveryDeadline: number | undefined): number {
    const remaining = this.host.remainingRecoveryTime(recoveryDeadline);
    return remaining === undefined ? timeoutMs : Math.min(timeoutMs, remaining);
  }

  private isMissingProcessError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("ESRCH");
  }

  /**
   * Wait for daemon process to stop
   *
   * Public so tests can drive the stop wait directly.
   */
  async waitForStop(
    pid: number,
    timeout: number,
    expectedGeneration?: DaemonProcessRecord,
  ): Promise<WaitForStopResult> {
    const deadline = this.host.timer.now() + timeout;
    const pollInterval = 100;

    const replacementWasObserved = (candidates: DaemonProcessRecord[]): boolean => {
      if (expectedGeneration === undefined) {
        return false;
      }
      // The global process scan can find a different checkout's daemon after OS PID
      // reuse. Only this namespace's PID record naming that candidate proves it took
      // over our namespace rather than being an unrelated daemon elsewhere.
      const pidData = this.host.identityRecoveryIO.readRecord();
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
        processGenerationToken: recordedProcessGenerationToken(pidData),
      };
      return candidates.some(
        (candidate) =>
          this.host.isConfirmedDifferentDaemonGeneration(expectedGeneration, candidate) &&
          this.host.matchesObservedDaemonGeneration(recordedGeneration, candidate),
      );
    };

    const checkStopped = (): WaitForStopResult | undefined => {
      if (!this.host.isProcessRunning(pid)) {
        return { stopped: true, replacedByOtherGeneration: false };
      }
      if (expectedGeneration === undefined) {
        return undefined;
      }
      const scanBudget = this.host.remainingTime(deadline);
      if (scanBudget <= 0) {
        return undefined;
      }
      try {
        const candidates = this.host.findLiveDaemonProcessRecords(scanBudget);
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

    while (this.host.remainingTime(deadline) > 0) {
      const result = checkStopped();
      if (result !== undefined) {
        return result;
      }
      await this.host.timer.sleep(pollInterval);
    }

    return checkStopped() ?? { stopped: false, replacedByOtherGeneration: false };
  }

  /**
   * Check if a process is running
   */
  isProcessRunning(pid: number): boolean {
    return this.host.processLivenessChecker.isProcessRunning(pid);
  }

  /**
   * Whether the PID's current holder is DEFINITELY a different process
   * generation than the one recorded (issue #10108). A missing token reader or
   * any unreadable token answers false, so uncertainty keeps the PID trusted as
   * the recorded daemon exactly as before.
   */
  private isRecycledPid(
    record: {
      pid: number;
    } & ProcessGenerationRecordFields,
  ): boolean {
    const readToken = this.host.processLivenessChecker.readProcessGenerationToken;
    return (
      readToken !== undefined &&
      isConfirmedRecycledProcess(
        record.pid,
        record,
        (pid) => readToken.call(this.host.processLivenessChecker, pid),
        this.host.pidFilePath,
      )
    );
  }

  /** Alive by PID AND still the recorded generation (never a recycled PID). */
  isRecordedDaemonRunning(
    record: {
      pid: number;
    } & ProcessGenerationRecordFields,
  ): boolean {
    return this.host.isProcessRunning(record.pid) && !this.isRecycledPid(record);
  }

  /**
   * Get daemon PID from lock file
   */
  getPid(): number | null {
    if (!existsSync(this.host.pidFilePath)) {
      return null;
    }

    try {
      const pidFileContent = require("fs").readFileSync(this.host.pidFilePath, "utf-8");
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

export interface WaitForStopResult {
  stopped: boolean;
  replacedByOtherGeneration: boolean;
}

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
