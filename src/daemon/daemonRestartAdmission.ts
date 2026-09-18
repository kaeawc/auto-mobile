import { DaemonUnavailableError } from "./client";

export const DAEMON_PREPARE_RESTART_METHOD = "ide/prepareRestart";
export const DAEMON_PREPARE_MAINTENANCE_METHOD = "ide/prepareMaintenance";
export const DAEMON_COMPLETE_MAINTENANCE_METHOD = "ide/completeMaintenance";
export const DAEMON_RESTART_ADMITTED_METHOD = "ide/restartAdmitted";
export const DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD = "ide/restartAcceptanceSession";
export const DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD = "ide/commitAcceptanceRestart";
export const DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD = "ide/releaseAcceptanceRestart";
const ACTIVE_PROVISIONING_RESTART_RETRY_MS = 1_000;

export interface DaemonRestartPreparation {
  accepted: boolean;
  reason?: "active_operations" | "generation_changed" | "restart_pending" | "shutdown_unavailable";
}

/** Explicit host maintenance must prove no sessions or executions can be disrupted. */
export interface DaemonMaintenancePreparation {
  accepted: boolean;
  /**
   * Opaque, single-use capability minted by the daemon generation that fenced
   * maintenance. A separate `restart-admitted` process must present it before
   * the daemon will begin its own shutdown.
   */
  maintenanceToken?: string;
  reason?:
    | "active_operations"
    | "active_sessions"
    | "generation_changed"
    | "maintenance_pending"
    | "sessions_unavailable";
}

export interface DaemonAdmittedRestart {
  accepted: boolean;
  reason?:
    | "active_operations"
    | "active_sessions"
    | "generation_changed"
    | "maintenance_token_invalid"
    | "maintenance_token_consumed"
    | "restart_pending"
    | "shutdown_unavailable"
    | "sessions_unavailable";
}

/**
 * Signed in the operator harness and MAC-bound to one daemon generation. The
 * daemon additionally verifies the live session's immutable platform identity
 * before permitting the acceptance-only crash/restart path.
 */
export interface AcceptanceSessionRestartScope {
  sessionUuid: string;
  platform: "android" | "ios";
  stableDeviceId: string;
  controls: {
    androidSiblingAvdName: string;
    androidDuplicateSerial: string;
    iosSameNameSiblingUdid: string;
  };
  expiresAt: number;
}

export interface DaemonAcceptanceSessionRestart {
  accepted: boolean;
  /** Incarnation token for explicitly rolling back this socket-owned admission. */
  restartToken?: string;
  reason?:
    | "generation_changed"
    | "acceptance_capability_invalid"
    | "scope_invalid"
    | "scope_expired"
    | "session_not_found"
    | "session_identity_mismatch"
    | "unrelated_sessions"
    | "active_operations"
    | "restart_pending"
    | "shutdown_unavailable";
}

export interface DaemonAcceptanceRestartRelease {
  released: boolean;
}

export interface DaemonAcceptanceRestartCommit {
  committed: boolean;
}

/**
 * A compatibility restart was deliberately deferred because the current
 * generation could not prove that it was safe to terminate.
 */
export class DaemonRestartDeferredError extends DaemonUnavailableError {
  readonly code = "daemon_restart_deferred";
  readonly retryable = true;
  readonly retryAfterMs = ACTIVE_PROVISIONING_RESTART_RETRY_MS;

  constructor(reason: string) {
    super(
      `AutoMobile daemon restart deferred (${reason}). ` +
        `Retry after ${ACTIVE_PROVISIONING_RESTART_RETRY_MS}ms; use an explicit daemon restart ` +
        "only after confirming that no device operation is active.",
    );
    this.name = "DaemonRestartDeferredError";
  }
}

/** A provision request lost the atomic admission race to an accepted restart. */
export class DaemonRestartPendingError extends DaemonUnavailableError {
  readonly code = "daemon_restart_pending";
  readonly retryable = true;

  constructor() {
    super("Daemon restart is pending; retry provisionDevice after the replacement becomes ready.");
    this.name = "DaemonRestartPendingError";
  }
}
