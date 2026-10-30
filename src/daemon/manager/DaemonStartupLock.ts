import { type IdentityRecoveryIO } from "../identityRecovery";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { readFile } from "node:fs/promises";
import { constants, openSync, closeSync, fstatSync, readFileSync, writeSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { logger } from "../../utils/logger";
import { ActionableError } from "../../models";
import { DAEMON_STARTUP_TIMEOUT_MS } from "../wire/constants";
import { DaemonStatus, DaemonOptions } from "../types";
import { Timer } from "../../utils/SystemTimer";
import {
  compareLockOwnerGeneration,
  formatLockContent,
  parseLockContent,
  releaseExclusiveLock,
  tryAcquireExclusiveLock,
  type LockOwnerGenerationProbe,
} from "../../utils/fileLock";
import { stderrLog } from "./DaemonLaunch";
import { ABANDONED_WAIT_CONFIRM_TIMEOUT_MS } from "./DaemonReadiness";
import type { DaemonStartResult } from "../manager";

/** Only the replaceable manager seams used by DaemonStartupLock. */
export interface DaemonStartupLockHost {
  daemonLaunchLogPath(): string;
  readonly lockFilePath: string;
  isProcessRunning(pid: number): boolean;
  readonly lockOwnerGenerationProbe: LockOwnerGenerationProbe;
  readonly startupLockOwnerToken: string;
  readStartupLockHolder(): StartupLockHolder;
  readonly timer: Timer;
  remainingTime(deadline: number): number;
  throwIfRecoveryCancelled(signal: AbortSignal | undefined): void;
  getLockHolderStartupLogPath(): Promise<string | null>;
  acquireLock(): boolean;
  startUnlocked(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    inheritExitRecord?: boolean,
  ): Promise<DaemonStartResult>;
  releaseLock(): void;
  createLockHolderStartupFailure(retainedLogPath?: string | null): Promise<Error>;
  readSettledStartupLockHolder(deadline: number, signal?: AbortSignal): Promise<StartupLockHolder>;
  waitForReady(
    timeout: number,
    options?: {
      signal?: AbortSignal;
      shouldContinueWaiting?: () => boolean;
      maxProbeDurationMs?: number;
    },
  ): Promise<boolean>;
  sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void>;
  socketPathObservable(): boolean;
  verifyDaemonConnection(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  readonly identityRecoveryIO: IdentityRecoveryIO;
  authenticateSocketOwner(): Promise<DaemonStatus>;
  hasPublishedRecoveryIdentity(owner: DaemonStatus): boolean;
  describeError(error: unknown): string;
}

/** Daemon Startup Lock lifecycle operations. */
export class DaemonStartupLock {
  heldLockLogPath: string | undefined;
  constructor(private readonly host: DaemonStartupLockHost) {}
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
    const logPath = this.host.daemonLaunchLogPath();
    const acquired = tryAcquireExclusiveLock(this.host.lockFilePath, {
      isProcessRunning: (pid) => this.host.isProcessRunning(pid),
      ownerGeneration: this.host.lockOwnerGenerationProbe,
      // Written on line 2 so a follower can tell a replacement holder apart from
      // the one it was already waiting on even under PID reuse (issue #5904).
      // `reclaimOwnPid` stays false (the daemon's documented same-process contract),
      // so the token does not change acquire's stale-reclaim decision — it only
      // feeds the replacement-identity read in `readStartupLockHolder`.
      ownerToken: this.host.startupLockOwnerToken,
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
    releaseExclusiveLock(this.host.lockFilePath, process.pid, this.host.startupLockOwnerToken);
    this.heldLockLogPath = undefined;
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
  async startByAwaitingLockHolder(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    onTakeover?: () => Promise<DaemonStartResult>,
  ): Promise<DaemonStartResult> {
    let holderLogPath: string | null = null;
    let waitedOnHolder = this.host.readStartupLockHolder();

    // ONE arbitration deadline across every holder, replacements included, and the
    // final confirm bounded by whatever time is left under it — so a chain of
    // holders (A replaced by B near A's deadline) plus the confirm cannot push the
    // failure past the client's ~30s `tools/list` deadline, which would hide the
    // very error this change exists to deliver (issue #5878). The loop is bounded by
    // this deadline rather than a fixed iteration count, so a legitimate replacement
    // that reclaims the lock with time still on the clock is not cut off prematurely.
    const arbitrationDeadline = this.host.timer.now() + DAEMON_STARTUP_TIMEOUT_MS;

    // A wait on a live holder polls on an interval and so consumes real time, and
    // a dead holder is either taken over or ends the loop — so the arbitration
    // deadline bounds the number of iterations; no separate count cap is needed
    // (and a count cap would wrongly cut off a legitimate replacement that reclaims
    // the lock with time still on the clock).
    while (this.host.remainingTime(arbitrationDeadline) > 0) {
      this.host.throwIfRecoveryCancelled(recoverySignal);
      const remaining = this.host.remainingTime(arbitrationDeadline);
      stderrLog("Another process is starting the daemon, waiting...");
      // Capture diagnostics while the current holder still holds the lock, so they
      // survive into the failure message if the holder later releases on failure.
      holderLogPath = (await this.host.getLockHolderStartupLogPath()) ?? holderLogPath;
      this.host.throwIfRecoveryCancelled(recoverySignal);
      // Recovery is asserted by this lock holder, never inferred from an ambient socket.
      waitedOnHolder = this.host.readStartupLockHolder();
      const ready = await this.waitForStartupLockHolder(
        arbitrationDeadline,
        remaining,
        waitedOnHolder,
        recoverySignal,
      );
      this.host.throwIfRecoveryCancelled(recoverySignal);
      if (ready) {
        stderrLog("Daemon started by another process");
        return "joined";
      }

      // The holder we waited on is gone — take over its start.
      this.host.throwIfRecoveryCancelled(recoverySignal);
      if (this.host.acquireLock()) {
        stderrLog("Previous lock holder failed, taking over daemon start...");
        try {
          this.host.throwIfRecoveryCancelled(recoverySignal);
          return await (onTakeover?.() ?? this.host.startUnlocked(options, recoverySignal));
        } finally {
          this.host.releaseLock();
        }
      }

      // We could not take over, so the lock is still held. Keep waiting only for a
      // genuinely different live holder (a replacement that reclaimed the lock while
      // the prior one died); a stuck same holder or a now-dead lock ends the loop.
      // Identity is by owner token, not PID, so a replacement that reused the prior
      // holder's PID — OS recycling, or a same-process sibling manager instance — is
      // still recognized as a replacement rather than read as the same stuck holder
      // (issue #5904).
      this.host.throwIfRecoveryCancelled(recoverySignal);
      const current = this.host.readStartupLockHolder();
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
      this.host.remainingTime(arbitrationDeadline),
    );
    this.host.throwIfRecoveryCancelled(recoverySignal);
    if (
      await this.confirmLockFollowerReady(
        confirmBudget,
        waitedOnHolder.recovering === true,
        recoverySignal,
      )
    ) {
      this.host.throwIfRecoveryCancelled(recoverySignal);
      stderrLog("Daemon became ready before reporting startup failure");
      return "joined";
    }
    throw await this.host.createLockHolderStartupFailure(holderLogPath);
  }

  private async waitForStartupLockHolder(
    deadline: number,
    remaining: number,
    holder: StartupLockHolder,
    signal?: AbortSignal,
  ): Promise<boolean> {
    Object.assign(holder, await this.host.readSettledStartupLockHolder(deadline, signal));
    const stillWaiting = () => this.isStillWaitingOnStartupLockHolder(holder);
    if (!holder.recovering) {
      const ready = await this.host.waitForReady(
        Math.min(remaining, this.host.remainingTime(deadline)),
        {
          signal,
          shouldContinueWaiting: stillWaiting,
          maxProbeDurationMs: LOCK_HOLDER_PROBE_TIMEOUT_MS,
        },
      );
      // The holder may enter replacement while the ordinary readiness probe awaits.
      const current = await this.host.readSettledStartupLockHolder(deadline, signal);
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
  async readSettledStartupLockHolder(
    deadline: number,
    signal?: AbortSignal,
  ): Promise<StartupLockHolder> {
    let holder = this.host.readStartupLockHolder();
    for (let attempt = 0; holder.metadataPending && attempt < 3; attempt++) {
      if (this.host.remainingTime(deadline) <= 0) {
        break;
      }
      await this.host.sleepUnlessAborted(Math.min(1, this.host.remainingTime(deadline)), signal);
      holder = this.host.readStartupLockHolder();
    }
    // Persistent corruption is not evidence that generic reachability is safe.
    return holder;
  }

  private async confirmLockFollowerReady(
    budget: number,
    requireIdentity: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (budget <= 0 || !this.host.socketPathObservable()) {
      return false;
    }
    return requireIdentity
      ? this.waitForPublishedLockHolderIdentity(this.host.timer.now() + budget, () => false, signal)
      : this.host.verifyDaemonConnection(budget);
  }

  /** A bounded observation: a stalled incumbent must not extend arbitration. */
  private async authenticateLockFollowerOwner(deadline: number): Promise<DaemonStatus> {
    const budget = Math.min(LOCK_HOLDER_PROBE_TIMEOUT_MS, this.host.remainingTime(deadline));
    if (budget <= 0 || !this.host.identityRecoveryIO.socketExists()) {
      return { running: false };
    }
    const timeout = new Error("Lock follower owner probe timed out");
    try {
      return await raceWithDeadline(this.host.authenticateSocketOwner(), {
        timer: this.host.timer,
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
    while (this.host.remainingTime(deadline) > 0) {
      this.host.throwIfRecoveryCancelled(signal);
      const owner = await this.authenticateLockFollowerOwner(deadline);
      if (owner.running && this.host.hasPublishedRecoveryIdentity(owner)) {
        return true;
      }
      if (!shouldContinueWaiting()) {
        return false;
      }
      await this.host.sleepUnlessAborted(Math.min(100, this.host.remainingTime(deadline)), signal);
    }
    return false;
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
  readStartupLockHolder(): StartupLockHolder {
    let content: string;
    try {
      content = readFileSync(this.host.lockFilePath, "utf-8").trim();
    } catch (error) {
      // Lock file is gone: the holder released it (finished or crashed). Nothing
      // left to wait on — stop so start() can re-acquire or surface its failure.
      logger.debug(
        `[DaemonManager] Startup lock unreadable while waiting for holder: ${this.host.describeError(error)}`,
      );
      return { present: false, livePid: undefined, token: undefined };
    }
    if (content.length === 0) {
      // A holder created the lock but has not written its PID yet (mirrors the
      // fileLock mid-write window); treat as still held so we do not abandon it,
      // but with no comparable identity yet.
      return { present: true, livePid: undefined, token: undefined };
    }
    const { pid, token, metadata, generation } = parseLockContent(content);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      // Unreadable PID — a holder may still be filling it in; keep waiting.
      return { present: true, livePid: undefined, token };
    }
    return this.host.isProcessRunning(pid) &&
      compareLockOwnerGeneration(this.host.lockOwnerGenerationProbe, pid, generation) !==
        "different"
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
    return this.host.readStartupLockHolder().present;
  }

  private isStillWaitingOnStartupLockHolder(waitedOnHolder: StartupLockHolder): boolean {
    const current = this.host.readStartupLockHolder();
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
    const deadline = this.host.timer.now() + timeoutMs;
    let waitedOnHolder = this.host.readStartupLockHolder();

    while (this.host.remainingTime(deadline) > 0) {
      const ready = await this.host.waitForReady(this.host.remainingTime(deadline), {
        shouldContinueWaiting: () => this.isStillWaitingOnStartupLockHolder(waitedOnHolder),
        maxProbeDurationMs: LOCK_HOLDER_PROBE_TIMEOUT_MS,
      });
      if (ready) {
        return true;
      }

      // The holder we waited on is gone. Re-arbitrate: if a genuinely different live
      // holder reclaimed the lock (A crashed, B took over between the predicate's
      // lock read and its liveness check), wait on B under the remaining budget; a
      // stuck same holder or a now-dead lock ends the wait.
      const current = this.host.readStartupLockHolder();
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
    const confirmBudget = Math.min(
      ABANDONED_WAIT_CONFIRM_TIMEOUT_MS,
      this.host.remainingTime(deadline),
    );
    if (
      confirmBudget > 0 &&
      this.host.socketPathObservable() &&
      (await this.host.verifyDaemonConnection(confirmBudget))
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
  markStartupLockRecovering(): void {
    const holder = this.host.readStartupLockHolder();
    if (holder.livePid !== process.pid || holder.token !== this.host.startupLockOwnerToken) {
      return;
    }
    // Filesystem capabilities belong to the host, not the simulated recovery platform.
    const { noFollow, unsafeWriteMask } =
      process.platform === "win32"
        ? { noFollow: 0, unsafeWriteMask: 0 }
        : { noFollow: constants.O_NOFOLLOW, unsafeWriteMask: 0o022 };
    let fd: number;
    try {
      fd = openSync(this.host.lockFilePath, constants.O_RDWR | noFollow, 0o600);
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
      const { pid, token, metadata, generation } = parseLockContent(lockContents.trim());
      if (pid !== process.pid || token !== this.host.startupLockOwnerToken) {
        throw new ActionableError("Startup lock ownership changed before identity recovery");
      }
      const recoveryMetadata = JSON.stringify({
        logPath: this.startupLockMetadata(metadata).logPath,
        recovering: true,
      });
      const content = formatLockContent(pid, token, recoveryMetadata, generation);
      // Pad shorter metadata so one write replaces the old body without a
      // write/truncate window in which followers could read trailing old bytes.
      writeSync(fd, content.padEnd(Buffer.byteLength(lockContents)), 0, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  async getLockHolderStartupLogPath(): Promise<string | null> {
    try {
      const lockContents = await readFile(this.host.lockFilePath, "utf-8");
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
      // Safe: diagnostics are optional and never determine lock ownership or readiness.
      logger.debug(
        `[DaemonManager] Unable to read startup lock holder diagnostics: ${this.host.describeError(error)}`,
      );
      return null;
    }
  }
}

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
export interface StartupLockHolder {
  metadataPending?: boolean;
  recovering?: boolean;
  present: boolean;
  livePid: number | undefined;
  token: string | undefined;
}
