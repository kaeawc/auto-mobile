import type { SessionDeviceProfile } from "./sessionRequirements";

export type SessionBrokerProtocolErrorCode =
  | "session_broker_exclusive"
  | "session_broker_unavailable"
  | "session_config_invalid"
  | "session_request_not_found";

export interface SessionBrokerFailure {
  code: string;
  message: string;
  retryable: boolean;
  /**
   * Set when a retry only succeeds under a fresh request ID: this request ID's terminal refusal
   * is stored and replays byte-identically, so resending it can never succeed.
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

/** Why a release call ends a session; absent for an ordinary client release. */
export type SessionBrokerReleaseReason = typeof SESSION_OWNER_EXITED_CODE;

export interface SessionBrokerReleaseResult {
  sessionUuid: string;
  outcome: "released" | "cleanup_pending" | "unknown_session";
}
