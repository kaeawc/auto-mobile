/**
 * Release a device session shortly after the client connection that acquired it
 * closes, when no other connection owns it and its owner has gone silent (#10503).
 *
 * Without this, a one-shot client that exits without releasing its session holds
 * the device until the heartbeat monitor reaps the session, and every other
 * client's explicit `getAndroid {deviceId}` is refused in the meantime. The grace
 * window is the same suspect window an owner gets after missing its lease
 * (#10051): a proxy whose socket merely dropped reconnects and heartbeats well
 * inside it, which cancels the release.
 *
 * A release the pool defers because the session still has work in flight is
 * re-armed, not dropped (#10663): it is retried on a short backoff until the
 * call settles, and an execution that never settles keeps the session only up to
 * {@link OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS}.
 */

import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { ownerLeaseHeartbeat, SUSPECT_GRACE_MS } from "./livenessOwnerLease";
import { MAX_CALLER_MCP_REQUEST_TIMEOUT_MS } from "./mcpRequestTimeout";
import type { Session } from "./sessionManager";

/** The release reason recorded for a session whose owning connection closed. */
export const OWNER_DISCONNECTED_RELEASE_REASON = "owner-disconnected";

/** How long a session whose owning connection closed is held before it is released. */
export const OWNER_DISCONNECT_GRACE_MS = SUSPECT_GRACE_MS;

/**
 * Longest an active execution may keep a session whose owner disconnected (#10663). No request's
 * deadline can exceed the caller timeout cap, so an execution still tracked this long after the
 * release was first deferred has outlived any deadline it could have had, and nobody is left to
 * consume its result.
 */
export const OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS = MAX_CALLER_MCP_REQUEST_TIMEOUT_MS;

/** Longest wait between retries of a deferred release. */
export const OWNER_DISCONNECT_RETRY_MAX_DELAY_MS = 5_000;

/** How a deferred release is retried: soon after the call settles, without a tight loop. */
export const OWNER_DISCONNECT_RETRY_BACKOFF: BackoffPolicy = exponentialBackoff({
  initialDelayMs: 1_000,
  maxDelayMs: OWNER_DISCONNECT_RETRY_MAX_DELAY_MS,
});

/** What the grace tracker needs from the pool. */
export interface OwnerDisconnectReleasePort {
  getSession(sessionId: string): Session | null;
  /** Whether a still-connected client owns the session. */
  hasConnectedOwner(sessionId: string): boolean;
  /**
   * Release exactly this session incarnation. Resolving while the session is still held means
   * the release was deferred (for example, a call is still running), and it is retried.
   */
  release(session: Session, reason: string): Promise<void>;
}

export interface OwnerDisconnectRetryOptions {
  /** Delay before each retry of a deferred release. */
  backoff?: BackoffPolicy;
  /**
   * How long after its first deferral a release keeps being retried. Defaults to the execution
   * veto ceiling plus one retry delay, so an attempt always lands past the ceiling.
   */
  maxDeferMs?: number;
}

type OwnerSession = Pick<
  Session,
  | "livenessPolicy"
  | "ownership"
  | "livenessOwnerToken"
  | "livenessOwnershipClaims"
  | "lastHeartbeat"
  | "lastOwnerHeartbeat"
  | "stallForgivenAt"
>;

/**
 * Why a session must NOT be released for its owner's disconnect, or undefined
 * when it may be.
 *
 * - A `cli-idle` session is owned by one-shot `--cli` processes that exit between
 *   invocations by design (#6870); its idle timeout governs it.
 * - An awaiting-owner rehydration has its own reconnect window.
 * - A session whose owner explicitly released liveness ownership is mid-handoff
 *   (#10337); the existing lease decides whether the successor claims it in time.
 * - An owner that heartbeated after its connection closed is alive elsewhere.
 */
export function ownerDisconnectReleaseBlocker(
  session: OwnerSession,
  closedAt: number,
): string | undefined {
  if (session.livenessPolicy !== "heartbeat") {
    return "cli-idle policy";
  }
  if (session.ownership === "awaiting-owner") {
    return "awaiting its rehydrated owner";
  }
  if (session.livenessOwnerToken === undefined && session.livenessOwnershipClaims?.size) {
    return "liveness ownership handoff in progress";
  }
  if (ownerLeaseHeartbeat(session) > closedAt) {
    return "owner heartbeated after the connection closed";
  }
  return undefined;
}

/**
 * Bounds how long active executions may veto the owner-disconnect release of a session
 * (#10663). The #5343 "never reap mid-call" rule holds while the call can still finish inside
 * any request deadline; past {@link OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS} the session is
 * released anyway.
 */
export class OwnerDisconnectExecutionVeto {
  /** When active executions first kept each session incarnation. */
  private readonly vetoedSince = new WeakMap<Session, number>();

  constructor(
    private readonly hasActiveExecutions: (sessionId: string) => boolean,
    private readonly timer: Timer,
    private readonly ceilingMs: number = OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS,
  ) {}

  /** Whether active executions still keep this session from its owner-disconnect release. */
  keeps(session: Session): boolean {
    if (!this.hasActiveExecutions(session.sessionId)) {
      this.vetoedSince.delete(session);
      return false;
    }
    const now = this.timer.now();
    const vetoedSince = this.vetoedSince.get(session);
    if (vetoedSince === undefined) {
      this.vetoedSince.set(session, now);
      logger.info(
        `[OwnerDisconnectRelease] Kept session ${session.sessionId} after its owner disconnected: ` +
          `executions are still active; retrying the release once they settle`,
      );
      return true;
    }
    const vetoedMs = now - vetoedSince;
    if (vetoedMs < this.ceilingMs) {
      return true;
    }
    this.vetoedSince.delete(session);
    logger.warn(
      `[OwnerDisconnectRelease] Session ${session.sessionId} was kept for ${vetoedMs}ms after its ` +
        `owner disconnected by executions that never settled; releasing it anyway past the ` +
        `${this.ceilingMs}ms unsettled-execution ceiling`,
    );
    return false;
  }
}

interface PendingRelease {
  session: Session;
  mcpSessionId: string;
  closedAt: number;
  /** The scheduled attempt; undefined while an attempt is in flight. */
  handle: NodeJS.Timeout | undefined;
  /** When the pool first deferred this release. */
  deferredSince: number | undefined;
  retries: number;
}

export class OwnerDisconnectRelease {
  private readonly pending = new Map<string, PendingRelease>();
  private readonly retryBackoff: BackoffPolicy;
  private readonly maxDeferMs: number;

  constructor(
    private readonly port: OwnerDisconnectReleasePort,
    private readonly timer: Timer,
    private readonly graceMs: number = OWNER_DISCONNECT_GRACE_MS,
    retry: OwnerDisconnectRetryOptions = {},
  ) {
    this.retryBackoff = retry.backoff ?? OWNER_DISCONNECT_RETRY_BACKOFF;
    this.maxDeferMs =
      retry.maxDeferMs ??
      OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS + OWNER_DISCONNECT_RETRY_MAX_DELAY_MS;
  }

  /** The connection `mcpSessionId` that owned `sessionId` closed and no other connection owns it. */
  ownerDisconnected(sessionId: string, mcpSessionId: string): void {
    const session = this.port.getSession(sessionId);
    if (!session) {
      return;
    }
    const closedAt = this.timer.now();
    const blocker = ownerDisconnectReleaseBlocker(session, closedAt);
    if (blocker) {
      logger.debug(
        `[OwnerDisconnectRelease] Keeping session ${sessionId} after connection ${mcpSessionId} closed: ${blocker}`,
      );
      return;
    }
    this.cancel(sessionId);
    const handle = this.timer.setTimeout(() => this.fire(sessionId), this.graceMs);
    this.pending.set(sessionId, {
      session,
      mcpSessionId,
      closedAt,
      handle,
      deferredSince: undefined,
      retries: 0,
    });
  }

  /** A connection owns the session again, or the session ended: drop any pending release. */
  cancel(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) {
      return;
    }
    if (pending.handle !== undefined) {
      this.timer.clearTimeout(pending.handle);
    }
    this.pending.delete(sessionId);
  }

  isPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  private fire(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) {
      return;
    }
    pending.handle = undefined;
    const { session, mcpSessionId, closedAt } = pending;
    if (this.port.getSession(sessionId) !== session || this.port.hasConnectedOwner(sessionId)) {
      this.pending.delete(sessionId);
      return;
    }
    const blocker = ownerDisconnectReleaseBlocker(session, closedAt);
    if (blocker) {
      this.pending.delete(sessionId);
      logger.info(
        `[OwnerDisconnectRelease] Keeping session ${sessionId} after connection ${mcpSessionId} closed: ${blocker}`,
      );
      return;
    }
    const attemptAt = this.timer.now();
    if (pending.deferredSince === undefined) {
      logger.info(
        `[OwnerDisconnectRelease] Releasing session ${sessionId} on device ${session.assignedDevice}: ` +
          `its owning connection ${mcpSessionId} closed ${attemptAt - closedAt} ms ago and ` +
          `no other client owns it (reason=${OWNER_DISCONNECTED_RELEASE_REASON})`,
      );
    }
    // The entry stays pending while the attempt is in flight so a reconnecting owner's cancel()
    // also stops any retry of it.
    this.port.release(session, OWNER_DISCONNECTED_RELEASE_REASON).then(
      () => this.afterAttempt(sessionId, pending, attemptAt),
      (error: unknown) => {
        if (this.pending.get(sessionId) === pending) {
          this.pending.delete(sessionId);
        }
        // The heartbeat monitor still reaps the session at its lease; log for the trace.
        logger.warn(
          `[OwnerDisconnectRelease] Failed to release session ${sessionId}: ${errorMessage(error)}`,
          error,
        );
      },
    );
  }

  /** Re-arm a release the pool deferred, while it has not been cancelled or outlived its bound. */
  private afterAttempt(sessionId: string, pending: PendingRelease, attemptAt: number): void {
    if (this.pending.get(sessionId) !== pending) {
      return;
    }
    if (this.port.getSession(sessionId) !== pending.session) {
      this.pending.delete(sessionId);
      return;
    }
    pending.deferredSince ??= attemptAt;
    const deferredMs = attemptAt - pending.deferredSince;
    if (deferredMs >= this.maxDeferMs) {
      this.pending.delete(sessionId);
      logger.warn(
        `[OwnerDisconnectRelease] Gave up releasing session ${sessionId} after it was deferred for ` +
          `${deferredMs} ms; its heartbeat lease still governs it`,
      );
      return;
    }
    pending.retries += 1;
    const delayMs = this.retryBackoff.delayForAttempt(pending.retries);
    logger.debug(
      `[OwnerDisconnectRelease] Release of session ${sessionId} was deferred; retrying in ${delayMs} ms`,
    );
    pending.handle = this.timer.setTimeout(() => this.fire(sessionId), delayMs);
  }
}
