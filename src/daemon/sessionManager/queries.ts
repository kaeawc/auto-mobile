import type { SessionManagerCollaboratorHost } from "./host";
import type {
  Session,
  SessionReleaseSnapshot,
  HeldDeviceSession,
  SessionManager,
} from "../sessionManager";
import { createLegacyLifecycleView } from "../legacyLifecycleView";
import {
  deriveHeldSlotSession,
  deriveKnownSessionIds,
  deriveLatestSessionIdentity,
  isSlotCurrentSession,
  type LegacyLifecycleView,
} from "../sessionSlots";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../models/managedExecutionLiveness";

/** Read and listing views share the live lifecycle table without owning admission or mutation. */
export class SessionQueries {
  private lifecycleView?: LegacyLifecycleView<Session>;
  constructor(
    private readonly host: SessionManagerCollaboratorHost,
    private readonly facade: Pick<SessionManager, "getAllSessions" | "getAssignedDevices">,
  ) {}
  /**
   * Get device assigned to a session
   */
  getDeviceForSession(sessionId: string): string | null {
    const session = this.host.findSession(sessionId);
    if (!session) {
      return null;
    }
    return session.assignedDevice;
  }
  /** Final reason for this exact identity, including releases joined during teardown. */
  getFinalizedReleaseReason(session: Session): string | undefined {
    return this.host.finalizedSessionReleases.get(session)?.finalizedSnapshot?.releaseReason;
  }

  getTerminalReleaseSnapshot(sessionId: string): SessionReleaseSnapshot | undefined {
    const snapshot = this.host.sessionSlots.getTerminalSnapshot(sessionId);
    return snapshot ? { ...snapshot, heartbeat: { ...snapshot.heartbeat } } : undefined;
  }
  /**
   * Get session assigned to a device (reverse lookup)
   */
  getSessionForDevice(deviceId: string): string | null {
    return this.host.deviceSessionMap.get(deviceId) ?? null;
  }
  /** The same holders as getSessionForDevice, including expired and releasing sessions. */
  getHeldDeviceSessions(): readonly HeldDeviceSession[] {
    return [...this.host.deviceSessionMap].flatMap(([deviceId, sessionId]) => {
      const session = deriveHeldSlotSession(this.host.getLegacyLifecycleView(), sessionId);
      return session
        ? [
            {
              deviceId,
              sessionId,
              platform: session.platform,
              stableDeviceId: session.stableDeviceId,
            },
          ]
        : [];
    });
  }
  /** Map membership, including fenced releases and any newer same-UUID incarnation. */
  hasSession(sessionId: string): boolean {
    return this.host.sessions.has(sessionId);
  }
  /**
   * Whether this daemon holds `sessionId` as a live broker binding execution (#11275): present, on
   * the `managed-execution` policy and not being released. The stored idle deadline does not
   * decide managed liveness; a lapsed owner lease stays live until the heartbeat path actually
   * releases the session. A rehydrated session waiting for its proxy counts until released too.
   * Side-effect free apart from the stall probe every lookup runs.
   */
  isLiveManagedExecutionSession(sessionId: string): boolean {
    const session = this.host.expireIfDue(sessionId, false, undefined, false);
    return (
      session !== null &&
      session.livenessPolicy === MANAGED_EXECUTION_LIVENESS_POLICY &&
      !this.host.sessionSlots.isReleasing(session)
    );
  }
  /** Read-only shadow adapter; its maps reflect subsequent lifecycle mutations. */
  getLegacyLifecycleView(): LegacyLifecycleView<Session> {
    return (this.lifecycleView ??= createLegacyLifecycleView(
      {
        sessions: this.host.sessions,
        pendingAssignments: this.host.sessionSlots.assignments,
        pendingCreations: this.host.sessionSlots.creations,
        pendingReleases: this.host.sessionSlots.releaseRequests,
        pendingRebinds: this.host.sessionSlots.rebinds,
        releaseOps: this.host.sessionSlots.releaseOps,
        terminalSnapshots: this.host.sessionSlots.terminalSnapshots,
        recoveredTerminalIntents: this.host.sessionSlots.recoveredTerminalIntents,
        latestFinalizedIdentities: this.host.sessionSlots.latestFinalizedIdentities,
      },
      { has: (session) => this.host.sessionSlots.isReleasing(session) },
    ));
  }

  isCurrentSession(session: Session): boolean {
    return isSlotCurrentSession(this.host.getLegacyLifecycleView(), session.sessionId, session);
  }

  isAdmittedForAutomation(session: Session): boolean {
    return this.host.isCurrentSession(session) && !this.host.sessionSlots.isReleasing(session);
  }
  /** Read ownership without admission, expiry cleanup or the stall probe (release guard, #11920). */
  getSessionLivenessOwnerToken(sessionId: string): string | undefined {
    return (
      this.host.sessions.get(sessionId) ?? this.host.sessionSlots.getReleaseOp(sessionId)?.session
    )?.livenessOwnerToken;
  }
  /** Resolve an admitted release even after ordinary session lookup hides its identity. */
  getReleasingSession(sessionId: string): Session | null {
    return this.host.sessionSlots.getReleaseOp(sessionId)?.session ?? null;
  }
  /** Whether this is the newest published, releasing, or finalized incarnation for its UUID. */
  isLatestSessionIdentity(
    session: Session,
    options: { ignorePendingAssignment?: boolean } = {},
  ): boolean {
    return (
      deriveLatestSessionIdentity(
        this.host.getLegacyLifecycleView(),
        session.sessionId,
        options.ignorePendingAssignment,
      ) === session
    );
  }
  /**
   * Get count of active sessions
   */
  getActiveSessionCount(): number {
    return this.host.sessions.size;
  }
  /**
   * Get all active sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.host.sessions.values()).filter((s) => !this.host.isSessionExpired(s));
  }
  /** Snapshot every in-memory session, including expired entries awaiting cleanup. */
  getAllSessionIds(): string[] {
    return Array.from(this.host.sessions.keys());
  }
  /**
   * Snapshot every session identity that is published or still completing
   * creation, assignment, rebind, or early-release work.
   */
  getAllKnownSessionIds(): string[] {
    return deriveKnownSessionIds(this.host.getLegacyLifecycleView());
  }
  /**
   * Get all devices currently assigned to sessions
   */
  getAssignedDevices(): Set<string> {
    return new Set(
      Array.from(this.host.sessions.values())
        .filter((s) => !this.host.isSessionExpired(s))
        .map((s) => s.assignedDevice),
    );
  }
  /**
   * Get statistics for monitoring
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    expiredSessions: number;
    assignedDevices: number;
  } {
    const activeSessions = this.facade.getAllSessions().length;
    const expiredSessions = this.host.sessions.size - activeSessions;

    return {
      totalSessions: this.host.sessions.size,
      activeSessions,
      expiredSessions,
      assignedDevices: this.facade.getAssignedDevices().size,
    };
  }
}
