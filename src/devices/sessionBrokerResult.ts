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

export interface SessionBrokerReleaseResult {
  sessionUuid: string;
  outcome: "released" | "cleanup_pending" | "unknown_session";
}
