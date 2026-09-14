import { DaemonUnavailableError } from "./client";

export const DAEMON_PREPARE_RESTART_METHOD = "ide/prepareRestart";
export const DAEMON_PREPARE_MAINTENANCE_METHOD = "ide/prepareMaintenance";
export const DAEMON_COMPLETE_MAINTENANCE_METHOD = "ide/completeMaintenance";
const ACTIVE_PROVISIONING_RESTART_RETRY_MS = 1_000;

export interface DaemonRestartPreparation {
  accepted: boolean;
  reason?: "active_operations" | "generation_changed" | "restart_pending" | "shutdown_unavailable";
}

/** Explicit host maintenance must prove no sessions or executions can be disrupted. */
export interface DaemonMaintenancePreparation {
  accepted: boolean;
  reason?:
    | "active_operations"
    | "active_sessions"
    | "generation_changed"
    | "maintenance_pending"
    | "sessions_unavailable";
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
