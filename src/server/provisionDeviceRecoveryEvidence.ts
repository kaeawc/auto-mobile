import type { ProvisionDeviceLifecycleOutcome } from "../devices/provisionDeviceLifecycle";

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

type DeviceOwnership = "created_by_request" | "adopted";

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

export interface ProvisionDeviceRecoveryInput {
  boundary: ProvisionDeviceFailureBoundary;
  nowMs: number;
  daemonBuild: string;
  lifecycle?: ProvisionDeviceLifecycleOutcome;
  /** Cancellation boundary: did the request's work settle within the bounded wait? */
  settled?: boolean;
  originalError?: { code: string; message: string };
  retryAfterMs?: number;
  /** Whether this request created the device or adopted an existing one, when observed. */
  ownership?: DeviceOwnership;
  /** Failure boundaries: the provider's own verdict on whether retrying can help. */
  retryable?: boolean;
}

type Cleanup = ProvisionDeviceRecoveryEvidence["cleanup"];
type NextAction = ProvisionDeviceRecoveryEvidence["nextAction"];

function cleanupFromLifecycle(lifecycle: ProvisionDeviceLifecycleOutcome | undefined): Cleanup {
  switch (lifecycle?.state) {
    case "cleanup_in_progress":
      return { status: "pending" };
    case "retained":
      return { status: "failed_device_retained" };
    // A successful destroy command alone does not prove the device is absent.
    case "removed":
      return { status: "reported_complete_unverified" };
    case "no_device_created":
      return { status: "unnecessary" };
    default:
      return { status: "unknown" };
  }
}

function isUnretryableFailureBoundary(input: ProvisionDeviceRecoveryInput): boolean {
  const failureBoundary =
    input.boundary === "readiness_failure" || input.boundary === "cleanup_failure";
  return failureBoundary && input.retryable !== true;
}

function withRetryAfter(action: NextAction, retryAfterMs: number | undefined): NextAction {
  return retryAfterMs !== undefined ? { ...action, retryAfterMs } : action;
}

function nextAction(input: ProvisionDeviceRecoveryInput, cleanup: Cleanup): NextAction {
  if (input.boundary === "caller_cancellation" && !input.settled) {
    return withRetryAfter(
      {
        action: "retry",
        reason:
          "The cancelled request's work is still settling; a retry waits behind it on the device lifecycle lease and adopts whatever device it left.",
        automaticRetrySafe: true,
      },
      input.retryAfterMs,
    );
  }
  if (cleanup.status === "failed_device_retained") {
    return retainedDeviceAction(input);
  }
  if (input.lifecycle?.state === "created_not_ready" && input.lifecycle.device) {
    return {
      action: "reacquire_retained_device",
      reason:
        "The device was created and still exists; retrying provisionDevice with the same device adopts it without creating another.",
      automaticRetrySafe: true,
    };
  }
  return evidenceGatedRetryAction(input, cleanup);
}

function retainedDeviceAction(input: ProvisionDeviceRecoveryInput): NextAction {
  if (!input.lifecycle?.device) {
    // A creation may have landed, but its exact identity was never resolved.
    return {
      action: "obtain_further_evidence",
      reason:
        "A device may have been created but its exact identity is unknown, so it was not removed; query inventory for it before acting.",
      automaticRetrySafe: false,
    };
  }
  return {
    action: "perform_cleanup",
    reason:
      "Cleanup failed and the device is retained; remove it by its exact identity (not its name) or reacquire it.",
    automaticRetrySafe: false,
  };
}

/** The retry path once settling and retained-device evidence are ruled out. */
function evidenceGatedRetryAction(
  input: ProvisionDeviceRecoveryInput,
  cleanup: Cleanup,
): NextAction {
  if (isUnretryableFailureBoundary(input)) {
    return {
      action: "obtain_further_evidence",
      reason:
        "The failure is not marked retryable; inspect the original error and the device inventory before acting.",
      automaticRetrySafe: false,
    };
  }
  if (!input.lifecycle) {
    return {
      action: "obtain_further_evidence",
      reason:
        "No lifecycle evidence was recorded, so the response cannot establish whether a device was created; query inventory before acting.",
      automaticRetrySafe: false,
    };
  }
  if (cleanup.status === "pending") {
    return withRetryAfter(
      {
        action: "retry",
        reason:
          "Cleanup of the created device is still settling; wait for it to finish before retrying so the retry does not race the removal.",
        automaticRetrySafe: false,
      },
      input.retryAfterMs,
    );
  }
  return {
    action: "retry",
    reason:
      "No device is left half-provisioned by this request; a retry starts a fresh provision and adopts the device if it exists.",
    automaticRetrySafe: true,
  };
}

type DeviceEvidence = Pick<ProvisionDeviceRecoveryEvidence, "device" | "outcomes">;

function settlementFor(
  input: ProvisionDeviceRecoveryInput,
): ProvisionDeviceRecoveryEvidence["outcomes"]["settlement"] {
  if (input.boundary !== "caller_cancellation") {
    return "not_applicable";
  }
  return input.settled ? "settled" : "settling";
}

function creationFromLifecycle(
  lifecycle: ProvisionDeviceLifecycleOutcome | undefined,
  ownership: DeviceOwnership | undefined,
): DeviceEvidence["outcomes"]["deviceCreation"] {
  if (lifecycle?.state === "no_device_created") {
    return "not_created";
  }
  // Observed ownership is more precise than the lifecycle state: an adopted
  // device that failed readiness was never created by this request.
  if (ownership && lifecycle) {
    return ownership === "adopted" ? "adopted" : "created";
  }
  switch (lifecycle?.state) {
    // A retained outcome without an identity never resolved whether creation landed.
    case "retained":
      return lifecycle.device ? "created" : "unknown";
    case "created_not_ready":
    case "cleanup_in_progress":
      return "created";
    default:
      return "unknown";
  }
}

function deviceEvidence(input: ProvisionDeviceRecoveryInput): DeviceEvidence {
  const { lifecycle } = input;
  return {
    ...(lifecycle?.device
      ? { device: { ...lifecycle.device, ownership: input.ownership ?? ("unknown" as const) } }
      : {}),
    outcomes: {
      deviceCreation: creationFromLifecycle(lifecycle, input.ownership),
      settlement: settlementFor(input),
    },
  };
}

export function buildProvisionDeviceRecoveryEvidence(
  input: ProvisionDeviceRecoveryInput,
): ProvisionDeviceRecoveryEvidence {
  const cleanup = cleanupFromLifecycle(input.lifecycle);
  const { device, outcomes } = deviceEvidence(input);
  return {
    schemaVersion: 2,
    boundary: input.boundary,
    ...(input.lifecycle ? { phaseReached: input.lifecycle.phase } : {}),
    ...(device ? { device } : {}),
    outcomes,
    cleanup,
    ...(input.originalError ? { originalError: input.originalError } : {}),
    nextAction: nextAction(input, cleanup),
    freshness: { observedAtMs: input.nowMs, daemonBuild: input.daemonBuild, source: "snapshot" },
  };
}
