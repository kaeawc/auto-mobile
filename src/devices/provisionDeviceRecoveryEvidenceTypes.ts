/**
 * Recovery evidence delivered in `provisionDevice` error responses. It is a
 * snapshot taken at `observedAtMs`: it lets a caller pick a safe next action
 * without parsing messages, and it never upgrades missing evidence to a
 * confirmed outcome ("unknown" stays "unknown").
 *
 * provisionDevice keeps no durable per-request record (#11065), so every retry
 * is a fresh request: the lifecycle lease serializes it behind any work still
 * holding the same exact device, and an existing device is adopted rather than
 * created twice.
 */
export type ProvisionDeviceFailureBoundary =
  | "daemon_handoff"
  | "caller_cancellation"
  | "readiness_failure"
  | "cleanup_failure";

export type DeviceOwnership = "created_by_request" | "adopted";

export type ProvisionDeviceRecoveryAction =
  | "retry"
  | "reacquire_retained_device"
  | "perform_cleanup"
  | "obtain_further_evidence";

interface RecoveryDevice {
  platform: "android" | "ios";
  stableId: string;
  name: string;
  runtimeDeviceId?: string;
}

export interface ProvisionDeviceRecoveryEvidence {
  schemaVersion: 2;
  boundary: ProvisionDeviceFailureBoundary;
  /** Lifecycle phase last recorded by the request, when any. */
  phaseReached?: string;
  /** Exact identity; a display name alone never authorizes destructive recovery. */
  device?: RecoveryDevice & { ownership: DeviceOwnership | "unknown" };
  outcomes: {
    deviceCreation: "created" | "adopted" | "not_created" | "unknown";
    /** Cancellation boundary only: whether the request's work ended within the bounded wait. */
    settlement: "not_applicable" | "settling" | "settled";
  };
  cleanup: {
    status:
      | "unnecessary"
      | "pending"
      | "failed_device_retained"
      | "reported_complete_unverified"
      | "unknown";
  };
  originalError?: { code: string; message: string };
  nextAction: {
    action: ProvisionDeviceRecoveryAction;
    reason: string;
    /** False when a caller or agent must not retry without further evidence. */
    automaticRetrySafe: boolean;
    retryAfterMs?: number;
  };
  freshness: { observedAtMs: number; daemonBuild: string; source: "snapshot" };
}
