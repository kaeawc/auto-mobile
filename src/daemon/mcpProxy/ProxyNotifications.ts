import {
  SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
  type SessionDeviceRebound,
} from "../sessionDeviceReboundBroadcast";
import { logger } from "../../utils/logger";
import { type DaemonClientLike } from "../client/client";
import {
  listChangedKindForMethod,
  RESOURCE_UPDATED_NOTIFICATION_METHOD,
  type ListChangedKind,
} from "../listChangedBroadcast";
import { HeldSessionLosses } from "../proxy/HeldSessionLosses";
import { isRecoverableHandoffOfOwnedSession } from "../proxy/notFoundDecision";
import { DAEMON_STALLED_CODE } from "../proxyLivenessRecovery";
import { isRecoverableDaemonHandoffReason, sessionReleaseReasonFamily } from "../releaseReasons";
import { type SessionReleaseSnapshot } from "../sessionManager/releaseTypes";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../sessionReleaseBroadcast";
import { PROGRESS_NOTIFICATION_METHOD, type DaemonNotification } from "../types";
import type { ProxyRuntime } from "./ProxyRuntime";
/** Operations supplied by the proxy's composition root. */
export interface ProxyNotificationsPort {
  handleResourceUpdated(notification: DaemonNotification, sourceClient: DaemonClientLike): void;
  invalidateDaemonList(kind: ListChangedKind): void;
  announceDaemonListChanged(kind: ListChangedKind): void;
  invalidateCache(): void;
  clearNotFoundHistory(sessionUuid: string): void;
  recordHeldSessionTerminalLoss(...args: Parameters<HeldSessionLosses["recordTerminalLoss"]>): void;
  dropHeldSession(sessionUuid: string, keepHandover?: boolean, keepNotFoundHistory?: boolean): void;
  fenceBoundSessionUuid(
    sessionUuid: string,
    reason: string,
    release?: SessionReleaseSnapshot,
  ): void;
}

type Runtime = Pick<
  ProxyRuntime,
  | "boundSessionUuid"
  | "brokerSessions"
  | "claimableSessions"
  | "daemonShutdownAnnouncedAt"
  | "daemonShutdownBarrier"
  | "discovery"
  | "finalizedRecordingOwners"
  | "handoverResolution"
  | "listPoller"
  | "livenessOwnershipClaimSent"
  | "otherHeldSessions"
  | "ownedDeviceSessions"
  | "progressListeners"
  | "recoverableBoundSessionHandoff"
  | "recoverableBoundSessionHandoffIsDeviceRestart"
  | "releaseLedger"
  | "stallHandovers"
  | "terminalBoundSession"
  | "timer"
>;

/** Notifications operations on a single proxy runtime. */
export class ProxyNotifications {
  private readonly reboundListeners = new Set<(event: SessionDeviceRebound) => void>();

  clearSessionDeviceReboundListeners(): void {
    this.reboundListeners.clear();
  }

  onSessionDeviceRebound(listener: (event: SessionDeviceRebound) => void): () => void {
    this.reboundListeners.add(listener);
    return () => {
      this.reboundListeners.delete(listener);
    };
  }

  private handleSessionDeviceRebound(notification: DaemonNotification): void {
    const { sessionId, previousDeviceId, deviceId, generation, stableDeviceId, avdName } =
      notification;
    if (!sessionId || !previousDeviceId || !deviceId || generation === undefined) {
      return;
    }
    // A derived `${base}:${label}` session is held through its base.
    const baseSessionId = sessionId.split(":", 1)[0] ?? sessionId;
    const heldBy = (candidate: string): boolean =>
      candidate === this.runtime.boundSessionUuid ||
      this.runtime.ownedDeviceSessions.has(candidate) ||
      this.runtime.otherHeldSessions.has(candidate) ||
      this.runtime.claimableSessions.has(candidate) ||
      this.runtime.brokerSessions.sessions.has(candidate);
    const held = heldBy(sessionId) || heldBy(baseSessionId);
    if (!held) {
      return;
    }
    for (const listener of this.reboundListeners) {
      try {
        listener({ sessionId, previousDeviceId, deviceId, generation, stableDeviceId, avdName });
      } catch (error) {
        logger.warn("[DaemonMcpProxy] session-device rebound listener failed", error);
      }
    }
  }
  constructor(
    private readonly runtime: Runtime,
    private readonly port: ProxyNotificationsPort,
  ) {}

  handleDaemonNotification(notification: DaemonNotification, sourceClient: DaemonClientLike): void {
    if (notification.method === SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD) {
      this.handleSessionDeviceRebound(notification);
      return;
    }
    if (notification.method === RESOURCE_UPDATED_NOTIFICATION_METHOD) {
      this.port.handleResourceUpdated(notification, sourceClient);
      return;
    }
    if (notification.method === SESSION_RELEASED_NOTIFICATION_METHOD) {
      this.handleSessionReleasedNotification(notification);
      return;
    }

    if (notification.method === PROGRESS_NOTIFICATION_METHOD) {
      this.handleProgressNotification(notification, sourceClient);
      return;
    }

    const kind = listChangedKindForMethod(notification.method);
    if (kind === undefined) {
      // Unknown pushed methods are expected as the daemon grows new
      // notification families; ignoring keeps old proxies forward-compatible.
      logger.debug(`[DaemonMcpProxy] Ignoring unknown daemon notification: ${notification.method}`);
      return;
    }

    if (this.runtime.listPoller.isPolling()) {
      // Push and poll can see the same change; the poller announces it once.
      this.port.invalidateDaemonList(kind);
      void this.runtime.listPoller.onPushed(kind);
      return;
    }
    this.runtime.listPoller.noteEmitted(kind);
    this.port.announceDaemonListChanged(kind);
  }

  // A late or unmatched progress frame is expected around call completion.
  handleProgressNotification(
    notification: DaemonNotification,
    sourceClient: DaemonClientLike,
  ): void {
    if (
      notification.requestId === undefined ||
      notification.progressToken === undefined ||
      notification.progress === undefined
    ) {
      return;
    }
    const registered = this.runtime.progressListeners
      .get(sourceClient)
      ?.get(notification.requestId);
    if (registered?.progressToken !== notification.progressToken) {
      return;
    }
    try {
      registered.listener(notification.progress, notification.total, notification.message);
    } catch (error) {
      // Best-effort: a throwing progress consumer must never break the
      // notification channel or the in-flight tool call it belongs to.
      logger.warn(
        `[DaemonMcpProxy] progress listener failed for token ${notification.progressToken}: ${error}`,
      );
    }
  }

  removeProgressListener(
    client: DaemonClientLike | undefined,
    requestId: string | undefined,
  ): void {
    if (!client || requestId === undefined) {
      return;
    }
    const listeners = this.runtime.progressListeners.get(client);
    listeners?.delete(requestId);
    if (listeners?.size === 0) {
      this.runtime.progressListeners.delete(client);
    }
  }

  handleSessionReleasedNotification(notification: DaemonNotification): void {
    // Record the release against the specific UUID so an in-flight call that
    // forwarded it cannot re-remember it. Exact matching leaves unrelated and
    // derived sessions untouched; the replay TTL remains a dropped-frame
    // backstop (issues #4610, #4655).
    const releasedSessionUuid =
      typeof notification.sessionId === "string" && notification.sessionId.trim().length > 0
        ? notification.sessionId.trim()
        : undefined;
    if (!releasedSessionUuid) {
      return;
    }
    const handleStallHandoverRelease = (): boolean => {
      const keepsHandover =
        this.runtime.brokerSessions.sessions.has(releasedSessionUuid) &&
        this.runtime.stallHandovers.get(releasedSessionUuid)?.handover.code ===
          DAEMON_STALLED_CODE &&
        isRecoverableDaemonHandoffReason(notification.reason ?? "");
      if (!keepsHandover) {
        this.runtime.handoverResolution.endLostSessionHandover(
          releasedSessionUuid,
          notification.reason,
        );
      }
      return keepsHandover;
    };
    const preservedStallHandover = handleStallHandoverRelease();
    this.runtime.finalizedRecordingOwners.remember(releasedSessionUuid, notification.recordingIds);
    if (notification.reason === "daemon-shutdown") {
      this.runtime.daemonShutdownAnnouncedAt = this.runtime.timer.now();
      // Daemon shutdown is connection-wide. Arm the successor barrier even when
      // this UUID belongs to an unresolved acquisition result that has not become
      // the current binding yet.
      this.runtime.daemonShutdownBarrier.arm();
    }
    if (preservedStallHandover) {
      // The stall fence already removed the binding. Keep its restore snapshot and claims,
      // rather than recording a loss or setting up a handoff for a binding that is absent.
      return;
    }
    if (this.releaseKeepsBinding(releasedSessionUuid, notification.reason)) {
      // The replacement daemon rehydrates this UUID as awaiting-owner. Preserve
      // the binding so the next call/heartbeat can reclaim it after reconnecting.
      this.runtime.recoverableBoundSessionHandoff = releasedSessionUuid;
      this.runtime.recoverableBoundSessionHandoffIsDeviceRestart =
        sessionReleaseReasonFamily(notification.reason ?? "") === "device-restart:";
      this.runtime.livenessOwnershipClaimSent = false;
      const heldHandoff = this.runtime.otherHeldSessions.get(releasedSessionUuid);
      if (heldHandoff) {
        heldHandoff.claimSent = false;
      }
      this.runtime.discovery.bumpEpoch();
      this.port.invalidateCache();
      return;
    }
    this.runtime.releaseLedger.recordSessionReleased(releasedSessionUuid, notification.reason);
    // A released session is no longer owned: drop it so a later fresh-screenshot
    // read stops owner-routing to it and falls back to the live binding (which the
    // daemon denies), matching the "released session remains denied" guarantee
    // (issue #5663).
    this.runtime.ownedDeviceSessions.delete(releasedSessionUuid);
    this.runtime.claimableSessions.delete(releasedSessionUuid);
    this.port.clearNotFoundHistory(releasedSessionUuid);
    this.port.recordHeldSessionTerminalLoss(
      releasedSessionUuid,
      notification.reason,
      notification.release,
    );
    this.port.dropHeldSession(releasedSessionUuid);
    if (
      releasedSessionUuid === this.runtime.boundSessionUuid ||
      releasedSessionUuid === this.runtime.terminalBoundSession?.sessionUuid
    ) {
      this.port.fenceBoundSessionUuid(
        releasedSessionUuid,
        this.reasonForReleaseNotification(releasedSessionUuid, notification.reason),
        notification.release,
      );
    }
  }

  reasonForReleaseNotification(sessionUuid: string, reason?: string): string {
    const terminal = this.runtime.terminalBoundSession;
    const reported =
      terminal?.sessionUuid === sessionUuid ? terminal.reportedStallLossReason : undefined;
    return reported ?? reason ?? "released";
  }

  /**
   * The one classification of a release the daemon reports for `sessionUuid`, whether in a
   * session-released notification or with a not-found heartbeat (keeper tick, first heartbeat,
   * liveness recovery): the binding survives only a recoverable handoff (`device-restart:<id>`,
   * a daemon shutdown or restart) of a session this proxy owns, because the daemon hands that
   * session back to the next call. Every other reason, terminal, merely reusable by name
   * (`plan-auto-release`) or unknown to this build, ends the binding: the proxy stops heartbeating
   * it and never attaches the UUID to a sessionless call again.
   */
  releaseKeepsBinding(sessionUuid: string, releaseReason: string | undefined): boolean {
    return isRecoverableHandoffOfOwnedSession(
      releaseReason,
      this.runtime.ownedDeviceSessions.has(sessionUuid),
    );
  }

  hasRecoverableBoundSessionHandoff(): boolean {
    return (
      this.runtime.recoverableBoundSessionHandoff !== undefined &&
      this.runtime.recoverableBoundSessionHandoff === this.runtime.boundSessionUuid
    );
  }
}
