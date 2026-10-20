import { isDeviceRestartReleaseReason } from "../../db/deviceSessionRepository";
import { ActionableError } from "../../models/ActionableError";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { isTerminalReleaseReason } from "../releaseReasons";
import { SessionReleasePersistTimeoutError } from "../releaseErrors";
import {
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  type Session,
  type SessionReleaseSnapshot,
  type SessionReleaseOperation,
  type SessionReleaseStage,
  type SessionReleaseOptions,
} from "../sessionManager";
import type { SessionSlots } from "../sessionSlots";
import type { TerminalReleaseJournal } from "../terminalReleaseJournal";
import type { SessionRowWriter } from "../sessionRowWriter";

export interface ForcedStuckReleasePort {
  sessionSlots(): Pick<
    SessionSlots<
      unknown,
      unknown,
      unknown,
      object,
      unknown,
      unknown,
      unknown,
      SessionReleaseOperation,
      SessionReleaseSnapshot,
      Session
    >,
    | "getReleaseOp"
    | "hasActiveRelease"
    | "getTerminalSnapshot"
    | "hasTerminalSnapshot"
    | "setTerminalSnapshot"
    | "setForcedNonTerminal"
    | "deleteTerminalSnapshot"
  >;
  removeSession(sessionId: string, expectedSession?: Session): boolean;
  notifySessionRelease(snapshot: SessionReleaseSnapshot, options?: SessionReleaseOptions): void;
  managedExecutionReleaseMarker(
    session: Pick<Session, "livenessPolicy">,
  ): Pick<SessionReleaseSnapshot, "livenessPolicy">;
  restartReleasePersistence(): Pick<
    WeakMap<SessionReleaseSnapshot, PromiseWithResolvers<void>>,
    "get" | "set"
  >;
  registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>, capMs: number): void;
  persistSessionRelease(snapshot: SessionReleaseSnapshot): Promise<boolean>;
  scheduleTerminalReleaseRetry(snapshot: SessionReleaseSnapshot): void;
  trackReleaseDrainWrite(write: Promise<void>): void;
  retryNonTerminalRowAfterRelease(snapshot: SessionReleaseSnapshot): Promise<void>;
  releaseRowSessions(): Pick<WeakMap<SessionReleaseSnapshot, WeakRef<Session>>, "set">;
  captureReleaseRowGeneration(
    snapshot: SessionReleaseSnapshot,
    rowGeneration: number | undefined,
  ): void;
  persistedRowGenerations(): Pick<WeakMap<Session, number>, "get">;
  volatileTerminalReleaseIntents(): Pick<Map<string, string>, "get" | "delete">;
  terminalReleaseJournal(): Pick<TerminalReleaseJournal, "resolve">;
  rowWriter(): Pick<SessionRowWriter, "cancel" | "liftTerminal">;
  timer: Timer;
  sessionNow(): number;
}

export class ForcedStuckRelease {
  constructor(private readonly port: ForcedStuckReleasePort) {}

  /**
   * Force a release that is stuck past the heartbeat monitor's deadline (#10963). The session is
   * released with the reason the stuck release carries (#11361): fenced terminally when that
   * reason is terminal (so its UUID never routes again), left recoverable or re-issuable when it
   * is not. Either way it is removed from the device maps, and its
   * device is quarantined only until the stuck release settles or {@link SESSION_RELEASE_TEARDOWN_CAP_MS}
   * passes, whichever is first; the caller then returns the device to the pool. Returns the device
   * to release and the stage the release was stuck in, or undefined when no release of this
   * session is in flight (it settled meanwhile) or it was already forced.
   */
  forceStuckRelease(
    sessionId: string,
  ): { deviceId: string; stage: SessionReleaseStage | undefined } | undefined {
    const operation = this.port.sessionSlots().getReleaseOp(sessionId);
    if (
      !operation ||
      operation.forced ||
      operation.commitDeclined ||
      !this.port.sessionSlots().hasActiveRelease(operation)
    ) {
      return undefined;
    }
    const { session } = operation;
    const deviceId = session.assignedDevice;
    operation.forced = true;
    // Stop every restore the stuck release started: the device is about to go back to the pool.
    operation.forcedAbort?.abort(
      new ActionableError(`Release of session ${sessionId} was forced; its teardown is abandoned`),
    );
    const fence = this.forcedReleaseSnapshot(sessionId, session, operation.reason.value);
    if (this.port.removeSession(sessionId, session)) {
      // The stuck release never reached its own notification: announce the release now so
      // proxies and stream servers stop treating the session as live.
      const snapshot = { ...fence, ...this.port.managedExecutionReleaseMarker(session) };
      if (isDeviceRestartReleaseReason(fence.releaseReason)) {
        // The callback's copy and the persisted fence must confirm the same row write.
        const persistence =
          this.port.restartReleasePersistence().get(fence) ?? Promise.withResolvers<void>();
        this.port.restartReleasePersistence().set(fence, persistence);
        this.port.restartReleasePersistence().set(snapshot, persistence);
      }
      this.port.notifySessionRelease(snapshot, {
        deviceIdentityReplaced:
          operation.stage === "awaiting-ownership" || operation.options.deviceIdentityReplaced,
      });
    }
    // The stuck release may never reach its own write: persist the release now (#11058), or a
    // restart would admit a terminally released UUID again.
    this.persistForcedReleaseFence(fence);
    const settled = operation.promise.then(
      () => undefined,
      () => undefined,
    );
    const capped = raceWithDeadline(settled, {
      timer: this.port.timer,
      timeoutMs: SESSION_RELEASE_TEARDOWN_CAP_MS,
      unref: true,
      label: "Forced stuck release",
    }).catch((error: unknown) => {
      // Reaching the cap is the expected outcome for a release that stays wedged: the device is
      // returned anyway, and the release's own stage was already reported above.
      logger.debug(`[SessionManager] Forced release of ${sessionId}: ${errorMessage(error)}`);
    });
    this.port.registerPendingDeviceCleanup(deviceId, capped, SESSION_RELEASE_TEARDOWN_CAP_MS);
    logger.warn(
      `[SessionManager] Forcing the stuck release of session ${sessionId} ` +
        `(stage=${operation.stage ?? "unknown"}, reason=${fence.releaseReason}): the session ` +
        `${fence.terminal ? "stays fenced" : "is released"} and device ` +
        `${deviceId} returns to the pool after at most ${SESSION_RELEASE_TEARDOWN_CAP_MS}ms`,
    );
    return { deviceId, stage: operation.stage };
  }

  /**
   * What a forced release releases the session as (#11361): the reason the stuck release was
   * started with, exactly as that release would have recorded it. A terminal reason raises (or
   * keeps) the in-memory fence; a non-terminal one (a `daemon-shutdown` or `device-restart:`
   * handoff, a `plan-auto-release`) raises none, so the session stays recoverable or its name
   * re-issuable as the reason says. Forcing only stops the wait for the device.
   */
  private forcedReleaseSnapshot(
    sessionId: string,
    session: Session,
    releaseReason: string,
  ): SessionReleaseSnapshot {
    const held = this.port.sessionSlots().getTerminalSnapshot(sessionId);
    if (held) {
      return held;
    }
    const releasedAtMs = this.port.sessionNow();
    const snapshot: SessionReleaseSnapshot = {
      sessionId,
      deviceId: session.assignedDevice,
      releaseReason,
      releasedAtMs,
      terminal: isTerminalReleaseReason(releaseReason),
      heartbeat: {
        lastHeartbeatMs: session.lastHeartbeat,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
        timeoutMs: session.heartbeatTimeoutMs,
        ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
      },
    };
    this.port.releaseRowSessions().set(snapshot, new WeakRef(session));
    this.port.captureReleaseRowGeneration(
      snapshot,
      this.port.persistedRowGenerations().get(session),
    );
    if (snapshot.terminal) {
      this.port.sessionSlots().setTerminalSnapshot(sessionId, snapshot);
    } else {
      // Applies only to the incarnation it released, like any non-terminal release (#11129).
      this.port.sessionSlots().setForcedNonTerminal(session, snapshot);
    }
    return snapshot;
  }

  /**
   * The in-flight release a later call for this UUID must wait on or join. A release forced with a
   * non-terminal reason (#11361) is not one: it already released the session and raised no fence,
   * so a recovery, a re-issue of the name or a later release of it must not wait on a teardown
   * that may stay wedged. A release forced with a terminal reason is answered by its fence first.
   */
  inFlightReleaseStillOwning(sessionId: string): SessionReleaseOperation | undefined {
    const operation = this.port.sessionSlots().getReleaseOp(sessionId);
    return operation?.forced && !this.port.sessionSlots().hasTerminalSnapshot(sessionId)
      ? undefined
      : operation;
  }

  /**
   * Write a forced release's row in the background, tracked by the shutdown drain. A terminal
   * write that fails falls back to the terminal-write retry (#10959); one that times out is
   * already retried by the late-write tracker if it then fails. A non-terminal write that fails
   * stays pending in {@link persistSessionRelease} and is handed to the existing row retry.
   */
  private persistForcedReleaseFence(fence: SessionReleaseSnapshot): void {
    const write = this.port.persistSessionRelease(fence).then(
      () => undefined,
      (error: unknown) => {
        logger.warn(
          `[SessionManager] Failed to persist the forced release of ${fence.sessionId}: ` +
            errorMessage(error),
        );
        if (fence.terminal && !(error instanceof SessionReleasePersistTimeoutError)) {
          this.port.scheduleTerminalReleaseRetry(fence);
        } else if (!fence.terminal && !(error instanceof SessionReleasePersistTimeoutError)) {
          this.port.trackReleaseDrainWrite(this.port.retryNonTerminalRowAfterRelease(fence));
        }
      },
    );
    this.port.trackReleaseDrainWrite(write);
  }

  liftTerminalFenceIfPresent(uuid: string): void {
    if (this.port.sessionSlots().hasTerminalSnapshot(uuid)) {
      this.liftTerminalFence(uuid);
    }
  }

  /** Lift/resolve in one synchronous turn. Confirm/refusal retains the terminal admission fence. */
  liftTerminalFence(
    uuid: string,
    resolved?: Pick<SessionReleaseSnapshot, "releaseReason">,
    retainFence = false,
    afterDelete?: () => void,
  ): void {
    if (!retainFence) {
      const deleted = this.port.sessionSlots().deleteTerminalSnapshot(uuid);
      if (afterDelete && !deleted) {
        return;
      }
      afterDelete?.();
    }
    if (
      !resolved ||
      this.port.volatileTerminalReleaseIntents().get(uuid) === resolved.releaseReason
    ) {
      this.port.volatileTerminalReleaseIntents().delete(uuid);
    }
    this.port.terminalReleaseJournal().resolve(uuid, resolved?.releaseReason);
    // Match only the resolved desire; a late completion must leave a successor's intent alone.
    if (resolved && "sessionId" in resolved) {
      this.port.rowWriter().cancel(uuid, resolved as SessionReleaseSnapshot);
    } else if (!retainFence) {
      this.port.rowWriter().liftTerminal(uuid);
    }
  }
}
