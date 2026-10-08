/**
 * Release a device session shortly after the client connection that acquired it
 * closes, when no other connection owns it and its owner has gone silent (#10503).
 *
 * Without this, a one-shot client that exits without releasing its session holds
 * the device until the heartbeat monitor reaps the session, and every other
 * client's explicit `getAndroid {deviceId}` is refused in the meantime. The grace
 * window is the lease plus the suspect window an owner gets after missing it
 * (#10051): a proxy whose socket merely dropped reconnects and heartbeats well
 * inside it, which cancels the release.
 *
 * A release the pool defers because the session still has work in flight is
 * re-armed, not dropped (#10663): it is retried when the vetoing call ends
 * ({@link OwnerDisconnectRelease.executionsEnded}, #10712), and in any case once
 * the veto's bound passes, so an execution that never settles keeps the session
 * only as long as the shared unsettled-execution veto policy allows.
 */

import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { ownerLeaseHeartbeat, SUSPECT_GRACE_MS } from "./livenessOwnerLease";
import {
  UNSETTLED_EXECUTION_VETO_CEILING_MS,
  UnsettledExecutionVeto,
  type SessionExecutionProbeInput,
} from "./unsettledExecutionVeto";
import type { Session } from "./sessionManager";
import { DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS } from "./sessionLivenessWindows";

/** The release reason recorded for a session whose owning connection closed. */
export const OWNER_DISCONNECTED_RELEASE_REASON = "owner-disconnected";

/**
 * How long a session whose owning connection closed is held before it is released: the time a
 * live owner has to deliver its next heartbeat (lease plus suspect grace), so a proxy whose socket
 * merely dropped can reconnect and heartbeat inside it.
 */
export const OWNER_DISCONNECT_GRACE_MS = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS;

/**
 * Longest an active execution may keep a session whose owner disconnected (#10663): the same
 * bound the heartbeat monitor applies, from the shared policy in `./unsettledExecutionVeto`.
 */
export const OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS = UNSETTLED_EXECUTION_VETO_CEILING_MS;

/** A release the pool deferred because in-flight work vetoed it. */
export interface OwnerDisconnectReleaseDeferral {
  /** When the veto stops holding; the release is retried then if no call end re-arms it first. */
  deferredUntil: number;
}

/** What the grace tracker needs from the pool. */
export interface OwnerDisconnectReleasePort {
  getSession(sessionId: string): Session | null;
  /** Whether a still-connected client owns the session. */
  hasConnectedOwner(sessionId: string): boolean;
  /**
   * Release exactly this session incarnation, or defer it while in-flight work vetoes it. A
   * deferred release is retried when one of the session's executions ends, or at
   * `deferredUntil`. Resolving with no deferral while the session is still held leaves the
   * session to its heartbeat lease.
   */
  release(session: Session, reason: string): Promise<OwnerDisconnectReleaseDeferral | void>;
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
  if (ownerHeartbeatSince(session) > closedAt) {
    return "owner heartbeated after the connection closed";
  }
  return undefined;
}

/**
 * The owner lease's start, counting only the owner's own heartbeats (and a daemon stall). Unlike
 * {@link ownerLeaseHeartbeat} it never falls back to the activity clock: the end of a call the
 * owner started before its connection closed refreshes `lastHeartbeat` (the idle window restarts
 * from a call's end), and that is not evidence the owner is still alive.
 */
function ownerHeartbeatSince(session: OwnerSession): number {
  return session.lastOwnerHeartbeat === undefined
    ? (session.stallForgivenAt ?? Number.NEGATIVE_INFINITY)
    : ownerLeaseHeartbeat(session);
}

/**
 * Bounds how long active executions may veto the owner-disconnect release of a session
 * (#10663). The #5343 "never reap mid-call" rule holds while the shared unsettled-execution veto
 * policy allows; past its bound the session is released anyway.
 */
export class OwnerDisconnectExecutionVeto {
  private readonly veto: UnsettledExecutionVeto;

  constructor(
    executions: SessionExecutionProbeInput,
    timer: Timer,
    ceilingMs: number = OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS,
  ) {
    this.veto = new UnsettledExecutionVeto(executions, timer, ceilingMs);
  }

  /**
   * The deferral while active executions still keep this session from its owner-disconnect
   * release, or undefined when it may be released now.
   */
  keeps(session: Session): OwnerDisconnectReleaseDeferral | undefined {
    const verdict = this.veto.judge(session);
    if (verdict.kind === "kept") {
      if (verdict.firstKept) {
        logger.info(
          `[OwnerDisconnectRelease] Kept session ${session.sessionId} after its owner disconnected: ` +
            `executions are still active; retrying the release once they end`,
        );
      }
      return { deferredUntil: verdict.until };
    }
    if (verdict.kind === "expired") {
      this.veto.forget(session);
      logger.warn(
        `[OwnerDisconnectRelease] Session ${session.sessionId} was kept for ${verdict.vetoedMs}ms after its ` +
          `owner disconnected by executions that never settled; releasing it anyway past their ` +
          `${verdict.bound} bound`,
      );
    }
    return undefined;
  }
}

interface PendingRelease {
  session: Session;
  mcpSessionId: string;
  closedAt: number;
  /** The scheduled attempt; undefined while an attempt is in flight. */
  handle: NodeJS.Timeout | undefined;
  /** Whether the pool has deferred this release at least once. */
  deferred: boolean;
  /** One of the session's executions ended while an attempt was in flight: retry at once. */
  rearmRequested: boolean;
}

export class OwnerDisconnectRelease {
  private readonly pending = new Map<string, PendingRelease>();

  constructor(
    private readonly port: OwnerDisconnectReleasePort,
    private readonly timer: Timer,
    private readonly graceMs: number = OWNER_DISCONNECT_GRACE_MS,
  ) {}

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
      deferred: false,
      rearmRequested: false,
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

  /**
   * Executions under these session ids ended (#10712): retry every release they deferred now,
   * instead of waiting for the veto's bound. A release still inside its disconnect grace is left
   * alone; one whose attempt is in flight retries as soon as that attempt settles.
   */
  executionsEnded(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      const pending = this.pending.get(sessionId);
      if (!pending?.deferred) {
        continue;
      }
      if (pending.handle === undefined) {
        pending.rearmRequested = true;
        continue;
      }
      this.timer.clearTimeout(pending.handle);
      pending.handle = this.timer.setTimeout(() => this.fire(sessionId), 0);
    }
  }

  private fire(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) {
      return;
    }
    pending.handle = undefined;
    pending.rearmRequested = false;
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
    if (!pending.deferred) {
      logger.info(
        `[OwnerDisconnectRelease] Releasing session ${sessionId} on device ${session.assignedDevice}: ` +
          `its owning connection ${mcpSessionId} closed ${this.timer.now() - closedAt} ms ago and ` +
          `no other client owns it (reason=${OWNER_DISCONNECTED_RELEASE_REASON})`,
      );
    }
    // The entry stays pending while the attempt is in flight so a reconnecting owner's cancel()
    // also stops any retry of it.
    this.port.release(session, OWNER_DISCONNECTED_RELEASE_REASON).then(
      (deferral) => this.afterAttempt(sessionId, pending, deferral),
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

  /**
   * Re-arm a release the pool deferred: on the next end of one of the session's executions
   * ({@link executionsEnded}), or when the veto's bound passes, whichever comes first.
   */
  private afterAttempt(
    sessionId: string,
    pending: PendingRelease,
    deferral: OwnerDisconnectReleaseDeferral | void,
  ): void {
    if (this.pending.get(sessionId) !== pending) {
      return;
    }
    if (this.port.getSession(sessionId) !== pending.session) {
      this.pending.delete(sessionId);
      return;
    }
    if (!deferral) {
      this.pending.delete(sessionId);
      logger.info(
        `[OwnerDisconnectRelease] Release of session ${sessionId} left it held without a deferral; ` +
          `its heartbeat lease still governs it`,
      );
      return;
    }
    pending.deferred = true;
    const delayMs = pending.rearmRequested
      ? 0
      : Math.max(0, deferral.deferredUntil - this.timer.now());
    pending.rearmRequested = false;
    logger.debug(
      `[OwnerDisconnectRelease] Release of session ${sessionId} was deferred; retrying when its ` +
        `executions end, or in ${delayMs} ms`,
    );
    pending.handle = this.timer.setTimeout(() => this.fire(sessionId), delayMs);
  }
}
