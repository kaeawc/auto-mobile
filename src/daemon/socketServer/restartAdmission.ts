import type { DaemonStateAccess } from "../daemonRequestHandlers";
import { executionTracker } from "../executionTracker";
import { logger } from "../../utils/logger";
import type { IdGenerator } from "../../utils/IdGenerator";
import type { Timer } from "../../utils/SystemTimer";
import type {
  AcceptanceSessionRestartScope,
  DaemonAcceptanceRestartCommit,
  DaemonAcceptanceRestartRelease,
  DaemonAcceptanceSessionRestart,
  DaemonAdmittedRestart,
  DaemonMaintenancePreparation,
  DaemonRestartPreparation,
} from "../daemonRestartAdmission";
import {
  daemonLiveAcceptanceScopedCapabilityMatches,
  type DaemonGenerationIdentity,
} from "../liveAcceptanceCapability";

/**
 * Restart admission for the control socket (#11815): the host-maintenance fence and the
 * acceptance-only crash fence, with their tokens, TTL timers and owner binding. The server injects
 * what it knows (its generation identity, sessions, timer, ids and the shutdown callback); this
 * class owns the admission state and the rules.
 */

/**
 * Maintenance spans separate control RPCs (and, for restart-admitted, separate
 * client processes), so it cannot be tied to one socket. Bound the global
 * execution fence instead: the default live-acceptance platform budget is just
 * under nine minutes, leaving a one-minute margin for valid fault/repair work.
 */
export const DAEMON_MAINTENANCE_ADMISSION_TTL_MS = 10 * 60 * 1000;
/**
 * Acceptance crash admission only spans generation revalidation and SIGKILL.
 * Keep enough margin for a loaded process-table scan while bounding an
 * abandoned process-global tool fence.
 */
export const DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS = 15_000;

export interface RestartAdmissionDeps {
  timer: Timer;
  idGenerator: IdGenerator;
  generationMatches: (params: Record<string, unknown>) => boolean;
  currentIdentity: () => DaemonGenerationIdentity;
  getAllSessions: () =>
    | ReturnType<NonNullable<ReturnType<DaemonStateAccess["getSessionManager"]>["getAllSessions"]>>
    | undefined;
  onRestartAccepted: (() => void) | undefined;
  liveAcceptanceStartupSecret: string | undefined;
}

export class RestartAdmission {
  private maintenanceAdmissionToken: string | undefined;
  private maintenanceAdmissionExpiresAt: number | undefined;
  private maintenanceAdmissionExpiryTimer: NodeJS.Timeout | undefined;
  private maintenanceAdmissionAbortController: AbortController | undefined;
  private maintenanceRestartConsumed = false;
  private acceptanceRestartAdmissionToken: string | undefined;
  private acceptanceRestartAdmissionOwnerSessionId: string | undefined;
  private acceptanceRestartAdmissionCommitted = false;
  private acceptanceRestartAdmissionExpiresAt: number | undefined;
  private acceptanceRestartAdmissionExpiryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: RestartAdmissionDeps) {}

  /** Daemon close: drop both fences and their timers. */
  releaseAll(): void {
    this.releaseDaemonMaintenanceAdmission(this.maintenanceAdmissionToken);
    this.releaseAcceptanceRestartAdmission(this.acceptanceRestartAdmissionToken);
  }

  prepareDaemonRestart(params: Record<string, unknown>): DaemonRestartPreparation {
    if (!this.deps.generationMatches(params)) {
      return {
        accepted: false,
        reason: "generation_changed",
      };
    }
    const admission = executionTracker.prepareForDaemonRestart();
    if (admission !== "accepted") {
      return {
        accepted: false,
        reason: admission,
      };
    }
    if (!this.deps.onRestartAccepted) {
      executionTracker.clearDaemonRestartPreparation();
      return {
        accepted: false,
        reason: "shutdown_unavailable",
      };
    }
    try {
      this.deps.onRestartAccepted();
      return { accepted: true };
    } catch (error) {
      logger.warn("Failed to initiate an admitted daemon restart", error);
      executionTracker.clearDaemonRestartPreparation();
      return {
        accepted: false,
        reason: "shutdown_unavailable",
      };
    }
  }

  prepareDaemonMaintenance(params: Record<string, unknown>): DaemonMaintenancePreparation {
    if (!this.deps.generationMatches(params)) {
      return { accepted: false, reason: "generation_changed" };
    }
    this.expireDaemonMaintenanceAdmission();
    const sessions = this.deps.getAllSessions();
    if (!sessions) {
      return { accepted: false, reason: "sessions_unavailable" };
    }
    const activeSessions = sessions.length;
    const admission = executionTracker.prepareForDaemonMaintenance(activeSessions);
    if (admission !== "accepted") {
      return { accepted: false, reason: admission };
    }
    const maintenanceToken = this.deps.idGenerator.next();
    this.maintenanceAdmissionToken = maintenanceToken;
    this.maintenanceAdmissionExpiresAt =
      this.deps.timer.now() + DAEMON_MAINTENANCE_ADMISSION_TTL_MS;
    this.maintenanceAdmissionExpiryTimer = this.deps.timer.setTimeout(
      () => this.releaseDaemonMaintenanceAdmission(maintenanceToken),
      DAEMON_MAINTENANCE_ADMISSION_TTL_MS,
    );
    this.maintenanceAdmissionAbortController = new AbortController();
    this.maintenanceRestartConsumed = false;
    return { accepted: true, maintenanceToken };
  }

  completeDaemonMaintenance(params: Record<string, unknown>): {
    completed: boolean;
  } {
    if (
      !this.deps.generationMatches(params) ||
      !this.daemonMaintenanceAdmissionMatches(params.maintenanceToken)
    ) {
      return { completed: false };
    }
    this.releaseDaemonMaintenanceAdmission(params.maintenanceToken);
    return { completed: true };
  }

  private daemonMaintenanceAdmissionMatches(token: unknown): token is string {
    this.expireDaemonMaintenanceAdmission();
    return (
      typeof token === "string" &&
      this.maintenanceAdmissionToken !== undefined &&
      token === this.maintenanceAdmissionToken
    );
  }

  private expireDaemonMaintenanceAdmission(): void {
    if (
      this.maintenanceAdmissionToken !== undefined &&
      this.maintenanceAdmissionExpiresAt !== undefined &&
      this.maintenanceAdmissionExpiresAt <= this.deps.timer.now()
    ) {
      this.releaseDaemonMaintenanceAdmission(this.maintenanceAdmissionToken);
    }
  }

  releaseDaemonMaintenanceAdmission(token: unknown): void {
    if (
      typeof token !== "string" ||
      this.maintenanceAdmissionToken === undefined ||
      token !== this.maintenanceAdmissionToken
    ) {
      return;
    }
    if (this.maintenanceAdmissionExpiryTimer !== undefined) {
      this.deps.timer.clearTimeout(this.maintenanceAdmissionExpiryTimer);
    }
    this.maintenanceAdmissionAbortController?.abort(
      new Error("Daemon maintenance admission expired or was released"),
    );
    executionTracker.clearDaemonMaintenancePreparation();
    this.maintenanceAdmissionToken = undefined;
    this.maintenanceAdmissionExpiresAt = undefined;
    this.maintenanceAdmissionExpiryTimer = undefined;
    this.maintenanceAdmissionAbortController = undefined;
    this.maintenanceRestartConsumed = false;
  }

  restartAdmittedDaemon(params: Record<string, unknown>): DaemonAdmittedRestart {
    if (!this.deps.generationMatches(params)) {
      return { accepted: false, reason: "generation_changed" };
    }
    if (!this.daemonMaintenanceAdmissionMatches(params.maintenanceToken)) {
      return { accepted: false, reason: "maintenance_token_invalid" };
    }
    if (this.maintenanceRestartConsumed) {
      return { accepted: false, reason: "maintenance_token_consumed" };
    }
    const sessions = this.deps.getAllSessions();
    if (!sessions) {
      return { accepted: false, reason: "sessions_unavailable" };
    }
    if (sessions.length > 0) {
      return { accepted: false, reason: "active_sessions" };
    }
    const admission = executionTracker.prepareForAdmittedDaemonRestart();
    if (admission !== "accepted") {
      return { accepted: false, reason: admission };
    }
    if (!this.deps.onRestartAccepted) {
      executionTracker.clearDaemonRestartPreparation();
      return { accepted: false, reason: "shutdown_unavailable" };
    }
    this.maintenanceRestartConsumed = true;
    try {
      this.deps.onRestartAccepted();
      return { accepted: true };
    } catch (error) {
      logger.warn("Failed to initiate a maintenance-admitted daemon restart", error);
      executionTracker.clearDaemonRestartPreparation();
      return { accepted: false, reason: "shutdown_unavailable" };
    }
  }

  restartAcceptanceSession(
    params: Record<string, unknown>,
    ownerSessionId: string | undefined,
  ): DaemonAcceptanceSessionRestart {
    if (!this.deps.generationMatches(params)) {
      return { accepted: false, reason: "generation_changed" };
    }
    if (ownerSessionId === undefined) {
      return { accepted: false, reason: "restart_pending" };
    }
    this.expireAcceptanceRestartAdmission();
    const scope = this.acceptanceSessionRestartScope(params.scope);
    if (!scope) {
      return { accepted: false, reason: "scope_invalid" };
    }
    if (scope.expiresAt <= this.deps.timer.now()) {
      return { accepted: false, reason: "scope_expired" };
    }
    const identity = this.deps.currentIdentity();
    if (
      !daemonLiveAcceptanceScopedCapabilityMatches(
        this.deps.liveAcceptanceStartupSecret,
        identity,
        scope,
        params.acceptanceCapability,
      )
    ) {
      return { accepted: false, reason: "acceptance_capability_invalid" };
    }
    const sessionRefusal = this.acceptanceRestartSessionRefusal(scope);
    if (sessionRefusal) {
      return sessionRefusal;
    }
    const admission = executionTracker.prepareForDaemonRestart();
    if (admission !== "accepted") {
      return {
        accepted: false,
        reason: admission === "active_operations" ? "active_operations" : "restart_pending",
      };
    }
    const restartToken = this.deps.idGenerator.next();
    const admissionTtlMs = Math.min(
      DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS,
      scope.expiresAt - this.deps.timer.now(),
    );
    this.acceptanceRestartAdmissionToken = restartToken;
    this.acceptanceRestartAdmissionOwnerSessionId = ownerSessionId;
    this.acceptanceRestartAdmissionCommitted = false;
    this.acceptanceRestartAdmissionExpiresAt = this.deps.timer.now() + admissionTtlMs;
    this.acceptanceRestartAdmissionExpiryTimer = this.deps.timer.setTimeout(
      () => this.releaseAcceptanceRestartAdmission(restartToken),
      admissionTtlMs,
    );
    // Graceful shutdown would terminally release the persisted session. The
    // manager commits the token before SIGKILL. Disconnect rolls back only an
    // uncommitted fence; after commit the lease keeps new work fenced through
    // the signal even if the control socket drops.
    return { accepted: true, restartToken };
  }

  private acceptanceRestartSessionRefusal(
    scope: AcceptanceSessionRestartScope,
  ): DaemonAcceptanceSessionRestart | undefined {
    const sessions = this.deps.getAllSessions();
    if (!sessions) {
      return { accepted: false, reason: "session_not_found" };
    }
    const session = sessions.find((candidate) => candidate.sessionId === scope.sessionUuid);
    if (!session) {
      return { accepted: false, reason: "session_not_found" };
    }
    if (
      session.platform !== scope.platform ||
      session.stableDeviceId !== scope.stableDeviceId ||
      sessions.length !== 1
    ) {
      return {
        accepted: false,
        reason:
          sessions.length !== 1 &&
          sessions.some((candidate) => candidate.sessionId !== scope.sessionUuid)
            ? "unrelated_sessions"
            : "session_identity_mismatch",
      };
    }
    return undefined;
  }

  /**
   * Acceptance-only crash admission for one persisted session. Unlike host
   * maintenance, this intentionally permits exactly the signed session to
   * survive in storage so the successor must prove stable-identity recovery.
   * It never touches a device; the manager kills only this verified daemon
   * generation after this RPC returns.
   */
  releaseAcceptanceRestart(
    params: Record<string, unknown>,
    ownerSessionId: string | undefined,
  ): DaemonAcceptanceRestartRelease {
    if (
      !this.deps.generationMatches(params) ||
      !this.acceptanceRestartAdmissionMatches(params.restartToken, ownerSessionId)
    ) {
      return { released: false };
    }
    this.releaseAcceptanceRestartAdmission(params.restartToken);
    return { released: true };
  }

  commitAcceptanceRestart(
    params: Record<string, unknown>,
    ownerSessionId: string | undefined,
  ): DaemonAcceptanceRestartCommit {
    if (
      !this.deps.generationMatches(params) ||
      !this.acceptanceRestartAdmissionMatches(params.restartToken, ownerSessionId)
    ) {
      return { committed: false };
    }
    this.acceptanceRestartAdmissionCommitted = true;
    return { committed: true };
  }

  private acceptanceRestartAdmissionMatches(
    token: unknown,
    ownerSessionId: string | undefined,
  ): token is string {
    this.expireAcceptanceRestartAdmission();
    return (
      typeof token === "string" &&
      ownerSessionId !== undefined &&
      token === this.acceptanceRestartAdmissionToken &&
      ownerSessionId === this.acceptanceRestartAdmissionOwnerSessionId
    );
  }

  private expireAcceptanceRestartAdmission(): void {
    if (
      this.acceptanceRestartAdmissionToken !== undefined &&
      this.acceptanceRestartAdmissionExpiresAt !== undefined &&
      this.acceptanceRestartAdmissionExpiresAt <= this.deps.timer.now()
    ) {
      this.releaseAcceptanceRestartAdmission(this.acceptanceRestartAdmissionToken);
    }
  }

  releaseAcceptanceRestartAdmissionForOwner(ownerSessionId: string): void {
    if (
      this.acceptanceRestartAdmissionCommitted ||
      ownerSessionId !== this.acceptanceRestartAdmissionOwnerSessionId
    ) {
      return;
    }
    this.releaseAcceptanceRestartAdmission(this.acceptanceRestartAdmissionToken);
  }

  releaseAcceptanceRestartAdmission(token: unknown): void {
    if (typeof token !== "string" || token !== this.acceptanceRestartAdmissionToken) {
      return;
    }
    if (this.acceptanceRestartAdmissionExpiryTimer !== undefined) {
      this.deps.timer.clearTimeout(this.acceptanceRestartAdmissionExpiryTimer);
    }
    executionTracker.clearDaemonRestartPreparation();
    this.acceptanceRestartAdmissionToken = undefined;
    this.acceptanceRestartAdmissionOwnerSessionId = undefined;
    this.acceptanceRestartAdmissionCommitted = false;
    this.acceptanceRestartAdmissionExpiresAt = undefined;
    this.acceptanceRestartAdmissionExpiryTimer = undefined;
  }

  private acceptanceSessionRestartScope(value: unknown): AcceptanceSessionRestartScope | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const scope = value as Partial<AcceptanceSessionRestartScope>;
    const controls = scope.controls;
    if (
      typeof scope.sessionUuid !== "string" ||
      scope.sessionUuid.length === 0 ||
      (scope.platform !== "android" && scope.platform !== "ios") ||
      typeof scope.stableDeviceId !== "string" ||
      scope.stableDeviceId.length === 0 ||
      !validRestartScopeExpiry(scope.expiresAt) ||
      !validRestartControls(controls)
    ) {
      return undefined;
    }
    return {
      sessionUuid: scope.sessionUuid,
      platform: scope.platform,
      stableDeviceId: scope.stableDeviceId,
      controls: {
        androidSiblingAvdName: controls.androidSiblingAvdName,
        androidDuplicateSerial: controls.androidDuplicateSerial,
        iosSameNameSiblingUdid: controls.iosSameNameSiblingUdid,
      },
      expiresAt: scope.expiresAt,
    };
  }
}

function validRestartControls(
  controls: AcceptanceSessionRestartScope["controls"] | undefined,
): controls is AcceptanceSessionRestartScope["controls"] {
  return !(
    !controls ||
    typeof controls !== "object" ||
    typeof controls.androidSiblingAvdName !== "string" ||
    typeof controls.androidDuplicateSerial !== "string" ||
    typeof controls.iosSameNameSiblingUdid !== "string"
  );
}

function validRestartScopeExpiry(expiresAt: number | undefined): expiresAt is number {
  return typeof expiresAt === "number" && Number.isFinite(expiresAt);
}
