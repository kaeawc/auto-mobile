import { toDaemonStatus } from "../clientResponseDecoding";
import { recordedProcessGenerationToken } from "../processGenerationFields";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { existsSync } from "node:fs";
import { logger } from "../../utils/logger";
import {
  DEFAULT_PID_FILE_PATH,
  DEFAULT_SOCKET_PATH,
  READINESS_PROBE_MAX_ATTEMPTS,
  READINESS_PROBE_BACKOFF_MS,
} from "../wire/constants";
import { DaemonStatus } from "../types";
import { type DaemonClientFactoryOptions, type DaemonClientLike } from "../client";
import { type DaemonSocketReachabilityLike } from "../daemonSocketReachability";
import { Timer } from "../../utils/SystemTimer";
import { type DaemonProcessRecord } from "../processTable";
import { stderrLog } from "./DaemonLaunch";

/** Only the replaceable manager seams used by DaemonReadiness. */
export interface DaemonReadinessHost {
  readonly timer: Timer;
  socketPathObservable(): boolean;
  remainingTime(deadline: number): number;
  sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void>;
  verifyDaemonConnection(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  isIsolatedSocketNamespace(): boolean;
  readonly peerSocketReachability: DaemonSocketReachabilityLike;
  readonly socketPath: string;
  findNamespaceDaemonProcessRecords(timeoutMs?: number): Promise<DaemonProcessRecord[]>;
  readonly platform: NodeJS.Platform;
  readonly pidFilePath: string;
  createClient(options?: DaemonClientFactoryOptions): DaemonClientLike;
  lifecycleStatus(): Promise<DaemonStatus>;
}

/** Daemon Readiness lifecycle operations. */
export class DaemonReadiness {
  constructor(private readonly host: DaemonReadinessHost) {}
  /**
   * Wait for daemon to be ready (socket listening)
   */
  async waitForReady(
    timeout: number,
    signal?: AbortSignal,
    shouldContinueWaiting: () => boolean = () => true,
    maxProbeDurationMs?: number,
    launchedProcess?: { pid: number | undefined; launchNonce?: string },
  ): Promise<boolean> {
    return launchedProcess
      ? this.waitForLaunchedProcessReady(
          launchedProcess.pid,
          timeout,
          signal ?? new AbortController().signal,
          launchedProcess.launchNonce,
        )
      : this.waitForObservedDaemonReady(timeout, signal, shouldContinueWaiting, maxProbeDurationMs);
  }

  private async waitForObservedDaemonReady(
    timeout: number,
    signal: AbortSignal | undefined,
    shouldContinueWaiting: () => boolean,
    maxProbeDurationMs: number | undefined,
  ): Promise<boolean> {
    const startTime = this.host.timer.now();
    const deadline = startTime + timeout;
    const pollInterval = 100; // Poll every 100ms
    let pollCount = 0;
    let socketObserved = false;

    while (this.host.timer.now() < deadline) {
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
      if (this.host.socketPathObservable()) {
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
            `Daemon readiness probe succeeded after ${this.host.timer.now() - startTime}ms ` +
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
            `Daemon readiness probe aborted after ${this.host.timer.now() - startTime}ms ` +
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
          `Daemon readiness wait abandoned after ${this.host.timer.now() - startTime}ms ` +
            `(${pollCount} polls); the process it was waiting on is no longer running`,
        );
        return false;
      }

      const remainingPollTimeMs = this.host.remainingTime(deadline);
      if (remainingPollTimeMs === 0) {
        break;
      }
      await this.host.sleepUnlessAborted(Math.min(pollInterval, remainingPollTimeMs), signal);
    }

    stderrLog(
      `Daemon readiness probe timed out after ${this.host.timer.now() - startTime}ms ` +
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
          maxProbeDurationMs === undefined ? deadline : this.host.timer.now() + maxProbeDurationMs,
        )
      : Math.min(deadline, this.host.timer.now() + ABANDONED_WAIT_CONFIRM_TIMEOUT_MS);
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
    if (await this.host.verifyDaemonConnection(this.host.remainingTime(deadline), signal)) {
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
    const interval = this.host.timer.setInterval(() => {
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
        this.host.timer.clearInterval(interval);
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
  async tryJoinPeerDaemonAfterSpawnExit(budgetMs: number): Promise<boolean> {
    // A non-default PID/socket path means the process-table scan below cannot be
    // trusted to identify a peer IN THIS socket namespace (issue #6140) — bound the
    // whole rejoin to a short grace in that case rather than the caller's full
    // start budget. The default namespace keeps the full budget, matching #6103.
    // See {@link isIsolatedSocketNamespace} for why the comparison uses the
    // built-in DEFAULT_* constants rather than PID_FILE_PATH/SOCKET_PATH.
    const effectiveBudgetMs = this.host.isIsolatedSocketNamespace()
      ? Math.min(budgetMs, PEER_DAEMON_ISOLATED_NAMESPACE_GRACE_MS)
      : budgetMs;
    const deadline = this.host.timer.now() + effectiveBudgetMs;

    // The process-table scan is a synchronous `ps`/PowerShell/CIM call that blocks the
    // event loop, so it must (a) never run BEFORE the authoritative socket probe, and
    // (b) never run more than once up front plus once per
    // PEER_DAEMON_PROCESS_SCAN_INTERVAL_MS — otherwise a stalling scan could consume the
    // whole deadline before an already-published peer socket is ever checked (issue
    // #6103). It is populated lazily, only after a socket-probe miss.
    let peerProcessComingUp: boolean | undefined;
    let nextProcessScanAt = this.host.timer.now();

    while (this.host.remainingTime(deadline) > 0) {
      // SOCKET-FIRST (authoritative), evaluated before any process scan: a reachable
      // socket means join immediately, regardless of what the best-effort scan would
      // say. This is an observation-only probe — it never unlinks or stale-cleans the
      // socket, so it cannot delete a live peer's endpoint during the race — and it is
      // platform-aware at the connect layer so a Windows named-pipe peer (no filesystem
      // entry) is still reached.
      const probeBudget = Math.min(
        ABANDONED_WAIT_CONFIRM_TIMEOUT_MS,
        this.host.remainingTime(deadline),
      );
      if (
        probeBudget > 0 &&
        (await this.host.peerSocketReachability.probe(this.host.socketPath, probeBudget)) ===
          "answered"
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
      const remainingForScan = this.host.remainingTime(deadline);
      if (remainingForScan === 0) {
        return false;
      }
      if (peerProcessComingUp === undefined || this.host.timer.now() >= nextProcessScanAt) {
        // Bound the scan itself by whatever remains of THIS loop's deadline, not just
        // the fixed DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS ceiling (issue #6140): with an
        // isolated-namespace grace or tight outer start-deadline headroom, the caller
        // can have far less than 5000ms left, and an exactly-zero check above does not
        // catch a small-but-nonzero remainder — the scan could still run to its full
        // ceiling and blow past both the grace and the outer delivery headroom before
        // the actionable launch error is ever delivered.
        peerProcessComingUp = await this.hasComingUpPeerDaemon(remainingForScan);
        nextProcessScanAt = this.host.timer.now() + PEER_DAEMON_PROCESS_SCAN_INTERVAL_MS;
      }
      if (!peerProcessComingUp) {
        // The process scan is a best-effort snapshot that can miss (or fail to inspect)
        // a peer that published its socket right after this iteration's probe. Do ONE
        // final observation-only socket probe before abandoning, so a just-published
        // winner is still joined rather than surfacing the loser's exit error (#6103).
        const finalBudget = Math.min(
          ABANDONED_WAIT_CONFIRM_TIMEOUT_MS,
          this.host.remainingTime(deadline),
        );
        if (
          finalBudget > 0 &&
          (await this.host.peerSocketReachability.probe(this.host.socketPath, finalBudget)) ===
            "answered"
        ) {
          stderrLog("Reusing a peer daemon that became ready after our launch exited");
          return true;
        }
        return false;
      }
      const remaining = this.host.remainingTime(deadline);
      if (remaining === 0) {
        break;
      }
      await this.host.timer.sleep(Math.min(PEER_DAEMON_JOIN_POLL_MS, remaining));
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
      return (await this.host.findNamespaceDaemonProcessRecords(timeoutMs)).length > 0;
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

  /** Wait for an already-starting daemon to become reachable. Public so tests can observe or stub the wait. */
  async waitForExistingDaemon(timeout: number): Promise<boolean> {
    const startTime = this.host.timer.now();
    const deadline = startTime + timeout;
    const pollInterval = 100;

    while (this.host.timer.now() < deadline) {
      if (await this.host.verifyDaemonConnection(this.host.remainingTime(deadline))) {
        return true;
      }
      const remainingPollTimeMs = this.host.remainingTime(deadline);
      if (remainingPollTimeMs === 0) {
        break;
      }
      await this.host.timer.sleep(Math.min(pollInterval, remainingPollTimeMs));
    }

    return false;
  }

  sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return this.host.timer.sleep(ms);
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
        this.host.timer.clearTimeout(timeout);
        done();
      };

      const timeout = this.host.timer.setTimeout(done, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  remainingTime(deadline: number): number {
    return Math.max(0, deadline - this.host.timer.now());
  }

  /**
   * Whether the daemon socket/pipe is observable at the filesystem layer before
   * attempting a connect. A Unix domain socket has a filesystem entry, so a
   * missing path means nothing is listening; a Windows named pipe has none, so
   * the existsSync gate must be skipped there entirely and the connect attempted
   * regardless (issue #6140) — mirroring {@link DaemonClient.isAvailable}'s
   * `platform() !== "win32"` branch.
   */
  socketPathObservable(): boolean {
    return this.host.platform === "win32" || existsSync(this.host.socketPath);
  }

  /** Compare built-in defaults so environment-overridden namespaces keep their short rejoin grace. */
  isIsolatedSocketNamespace(): boolean {
    return (
      this.host.pidFilePath !== DEFAULT_PID_FILE_PATH ||
      this.host.socketPath !== DEFAULT_SOCKET_PATH
    );
  }

  async verifyDaemonConnection(
    timeoutMs: number,
    signal?: AbortSignal,
    expected?: DaemonStatus,
  ): Promise<boolean> {
    const deadline = this.host.timer.now() + timeoutMs;

    // Retry the connect probe before declaring the socket unready. A single failed
    // probe is not authoritative — a live daemon under load can transiently
    // refuse a connection. The caller never unlinks the socket on a retry
    // exhaustion (issue #6140): a socket that fails every attempt here may still
    // be owned by a genuinely live, merely busy daemon.
    for (let attempt = 1; attempt <= READINESS_PROBE_MAX_ATTEMPTS; attempt++) {
      const remainingTimeoutMs = this.host.remainingTime(deadline);
      if (remainingTimeoutMs === 0 || signal?.aborted) {
        return false;
      }
      const client = this.host.createClient(expected ? { clientIdentity: null } : undefined);
      try {
        return await this.connectReadinessProbe(client, remainingTimeoutMs, signal, expected);
      } catch (error) {
        // Safe: a failed probe only retries within the original deadline; it never removes files.
        logger.debug(
          `Daemon socket readiness probe failed (attempt ${attempt}/${READINESS_PROBE_MAX_ATTEMPTS}): ${errorMessage(error)}`,
        );
      } finally {
        try {
          await client.close();
        } catch (error) {
          // Safe: this disposable probe is already finished; close failure cannot establish readiness.
          logger.debug(`Failed to close daemon readiness probe client: ${errorMessage(error)}`);
        }
      }

      const remainingAfterProbeMs = this.host.remainingTime(deadline);
      if (attempt < READINESS_PROBE_MAX_ATTEMPTS && remainingAfterProbeMs > 0) {
        await this.host.sleepUnlessAborted(
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
    expected?: DaemonStatus,
  ): Promise<boolean> {
    const probeAbort = new AbortController();
    const forwardAbort = () => probeAbort.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      return await raceWithDeadline(
        (async () => {
          const deadline = this.host.timer.now() + timeoutMs;
          await client.connect(timeoutMs, probeAbort.signal);
          if (!expected) {
            return true;
          }
          const remaining = this.host.remainingTime(deadline);
          if (remaining === 0 || probeAbort.signal.aborted) {
            return false;
          }
          const response = await client.callDaemonMethod(
            "ide/status",
            {},
            {
              timeoutMs: remaining,
              signal: probeAbort.signal,
              abortMode: "request",
            },
          );
          const responder = toDaemonStatus(response, this.host.socketPath);
          const mismatch = readinessIdentityMismatch(expected, responder);
          if (mismatch) {
            logger.debug(`Launched daemon readiness identity mismatch: ${mismatch}`);
          }
          return mismatch === undefined;
        })(),
        {
          timer: this.host.timer,
          timeoutMs,
          label: "Daemon readiness probe",
          timeoutError: () => new Error(`Daemon readiness probe timed out after ${timeoutMs}ms`),
          onTimeout: () => probeAbort.abort(),
        },
      );
    } finally {
      probeAbort.abort();
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /** Poll the spawned child's identity, never a predecessor's connect-only probe. */
  async waitForLaunchedProcessReady(
    pid: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
    launchNonce?: string,
  ): Promise<boolean> {
    const startTime = this.host.timer.now();
    const deadline = startTime + timeoutMs;
    let polls = 0;
    while (!signal.aborted && this.host.remainingTime(deadline) > 0) {
      polls++;
      if (
        await this.isLaunchedProcessReady(
          pid,
          Math.min(1000, this.host.remainingTime(deadline)),
          signal,
          launchNonce,
        )
      ) {
        stderrLog(
          `Launched daemon readiness succeeded after ${this.host.timer.now() - startTime}ms (${polls} polls)`,
        );
        return true;
      }
      await this.host.sleepUnlessAborted(Math.min(100, this.host.remainingTime(deadline)), signal);
    }
    stderrLog(
      `Launched daemon readiness ${signal.aborted ? "abandoned" : "timed out"} after ${this.host.timer.now() - startTime}ms (${polls} polls)`,
    );
    return false;
  }

  async isLaunchedProcessReady(
    pid: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
    launchNonce?: string,
  ): Promise<boolean> {
    if (pid === undefined) {
      logger.debug("Launched daemon readiness identity mismatch: spawned pid missing");
      return false;
    }

    const status = await this.host.lifecycleStatus();
    const identityMatches =
      launchNonce === undefined ? status.pid === pid : status.launchNonce === launchNonce;
    if (!status.running || !identityMatches) {
      const mismatch = launchNonce === undefined ? "spawned pid" : "launch nonce";
      logger.debug(
        `Launched daemon readiness identity mismatch: ${status.running ? mismatch : "not running"}`,
      );
      return false;
    }
    return this.verifyDaemonConnection(timeoutMs, signal, status);
  }
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
export const ABANDONED_WAIT_CONFIRM_TIMEOUT_MS = 1000;

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

/** Compare the PID record with the answering socket before declaring this launch ready. */
function readinessIdentityMismatch(
  expected: DaemonStatus,
  responder: DaemonStatus,
): string | undefined {
  if (responder.pid !== expected.pid) {
    return "pid";
  }
  if (expected.startedAt === undefined || responder.startedAt !== expected.startedAt) {
    return "startedAt";
  }
  if (recordedProcessGenerationToken(responder) !== recordedProcessGenerationToken(expected)) {
    return "generation token";
  }
  if (expected.launchNonce !== undefined && responder.launchNonce !== expected.launchNonce) {
    return "launch nonce";
  }
  return undefined;
}
