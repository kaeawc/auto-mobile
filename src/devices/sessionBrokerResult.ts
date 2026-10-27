import type { SessionDeviceProfile } from "./sessionRequirements";

export interface SessionBrokerAcquisitionTiming {
  admission: "reuse" | "create" | "evict-then-create" | "wait";
  reuseCount: number;
  outcome: "pending" | "ready" | "failed";
  startedAtMs: number;
  completedAtMs?: number;
  queueMs: number;
  admissionWaitMs: number;
  createMs?: number;
  bootMs?: number;
  automationReadyMs?: number;
  totalMs: number;
}

export type SessionBrokerResetMode =
  | "keep-booted"
  | "minimal"
  | "erase"
  | "snapshot"
  | "wipe-data"
  | "none";

export interface SessionBrokerResetTiming {
  mode: SessionBrokerResetMode;
  outcome:
    | "clean"
    | `fallback:${Exclude<SessionBrokerResetMode, "none">}`
    | "destroyed"
    | "pending";
  retired?: boolean;
  phases: Record<string, number>;
  fallbackReason?: string;
  reuseCount: number;
  startedAtMs: number;
  completedAtMs?: number;
  totalMs: number;
}

export interface SessionBrokerTiming {
  acquisition?: SessionBrokerAcquisitionTiming;
  reset?: SessionBrokerResetTiming;
}

export interface SessionBrokerPhaseStats {
  count: number;
  p50: number;
  p90: number;
}

export interface SessionBrokerStats {
  sinceMs: number;
  untilMs: number;
  limit: number;
  truncated: boolean;
  groups: Array<{
    profile: SessionDeviceProfile;
    acquisitions: number;
    resets: number;
    reuseHitRate: number;
    fallbackRate: number;
    retirements: number;
    acquisitionPhases: Record<string, SessionBrokerPhaseStats>;
    resetPhases: Record<string, SessionBrokerPhaseStats>;
  }>;
}

export type SessionBrokerProtocolErrorCode =
  | "session_broker_exclusive"
  | "session_broker_unavailable"
  | "session_broker_stopping"
  | "session_config_invalid"
  | "session_request_not_found"
  | "session_restart_handoff_pending"
  | "session_owner_mismatch"
  | "session_export_not_found"
  | "session_export_identity_mismatch";

export interface SessionBrokerFailure {
  /** Includes `eviction_pending` for unfinished idle eviction; managed `cleanup_pending` is distinct. */
  code: string;
  message: string;
  retryable: boolean;
  /** Suggested delay; durable `eviction_pending` receipts derive 1000 ms and require a new request ID. */
  retryAfterMs?: number;
  /**
   * Set when a retry only succeeds under a fresh request ID: this request ID's terminal refusal
   * is stored and replays byte-identically, so resending it can never succeed.
   * Retryable `eviction_pending` and `session_broker_stopping` receipts set it too.
   */
  retryRequires?: "new_request_id";
}

/** Consumer result intentionally has no scope, allocation index, lane, generation, or cap. */
export interface SessionBrokerResult {
  contractVersion: 1;
  requestId: string;
  outcome: "ready" | "pending" | "released" | "failed";
  sessionUuid: string | null;
  profile: SessionDeviceProfile | null;
  cleanupPending: boolean;
  failure?: SessionBrokerFailure;
  timing?: SessionBrokerTiming;
}

/**
 * The terminal code of a session whose owner died without releasing it (#12791). It is recorded
 * whether the broker's own recovery observes the death (a crashed provider) or the stdio proxy's
 * execution-owner watch does and reports it on its release call. An explicit release stays
 * `released`.
 */
export const SESSION_OWNER_EXITED_CODE = "session_owner_exited";
export const SESSION_OWNER_EXITED_MESSAGE =
  "Session owner exited before relinquishing its device; cleanup remains owned by the broker";

/**
 * The `timeout` failure's reason when no preparation budget remained to send
 * `daemon/prepareSession` at all: no request was made, so there is no receipt to clean up.
 */
export const NO_PREPARATION_BUDGET_REASON = "No preparation budget remains";

/** Why a release call ends a session; absent for an ordinary client release. */
export type SessionBrokerReleaseReason = typeof SESSION_OWNER_EXITED_CODE;

export interface SessionBrokerReleaseResult {
  sessionUuid: string;
  outcome: "released" | "cleanup_pending" | "unknown_session";
  timing?: SessionBrokerTiming;
}
