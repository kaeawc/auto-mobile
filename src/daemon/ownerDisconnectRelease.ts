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
 */

import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { ownerLeaseHeartbeat, SUSPECT_GRACE_MS } from "./livenessOwnerLease";
import type { Session } from "./sessionManager";

/** The release reason recorded for a session whose owning connection closed. */
export const OWNER_DISCONNECTED_RELEASE_REASON = "owner-disconnected";

/** How long a session whose owning connection closed is held before it is released. */
export const OWNER_DISCONNECT_GRACE_MS = SUSPECT_GRACE_MS;

/** What the grace tracker needs from the pool. */
export interface OwnerDisconnectReleasePort {
  getSession(sessionId: string): Session | null;
  /** Whether a still-connected client owns the session. */
  hasConnectedOwner(sessionId: string): boolean;
  /** Release exactly this session incarnation. */
  release(session: Session, reason: string): Promise<void>;
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

interface PendingRelease {
  session: Session;
  mcpSessionId: string;
  closedAt: number;
  handle: NodeJS.Timeout;
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
    this.pending.set(sessionId, { session, mcpSessionId, closedAt, handle });
  }

  /** A connection owns the session again, or the session ended: drop any pending release. */
  cancel(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) {
      return;
    }
    this.timer.clearTimeout(pending.handle);
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
    this.pending.delete(sessionId);
    const { session, mcpSessionId, closedAt } = pending;
    if (this.port.getSession(sessionId) !== session || this.port.hasConnectedOwner(sessionId)) {
      return;
    }
    const blocker = ownerDisconnectReleaseBlocker(session, closedAt);
    if (blocker) {
      logger.info(
        `[OwnerDisconnectRelease] Keeping session ${sessionId} after connection ${mcpSessionId} closed: ${blocker}`,
      );
      return;
    }
    logger.info(
      `[OwnerDisconnectRelease] Releasing session ${sessionId} on device ${session.assignedDevice}: ` +
        `its owning connection ${mcpSessionId} closed ${this.timer.now() - closedAt} ms ago and ` +
        `no other client owns it (reason=${OWNER_DISCONNECTED_RELEASE_REASON})`,
    );
    void this.port.release(session, OWNER_DISCONNECTED_RELEASE_REASON).catch((error: unknown) => {
      // The heartbeat monitor still reaps the session at its lease; log for the trace.
      logger.warn(
        `[OwnerDisconnectRelease] Failed to release session ${sessionId}: ${errorMessage(error)}`,
        error,
      );
    });
  }
}
