import type { ProvisionDeviceLifecycleOutcome } from "../db/provisionDeviceOperationRepository";

/**
 * Recovery evidence delivered in `provisionDevice` error responses. It is a
 * snapshot taken at `observedAtMs`: it lets a caller pick a safe next action
 * without parsing messages, and it never upgrades missing evidence to a
 * confirmed outcome ("unknown" stays "unknown").
 */
export type ProvisionDeviceFailureBoundary =
  | "daemon_handoff"
  | "caller_cancellation"
  | "result_persistence"
  | "readiness_failure"
  | "cleanup_failure";

type DeviceOwnership = "created_by_operation" | "adopted";

export type ProvisionDeviceRecoveryAction =
  | "retry_original_operation"
  | "wait_then_retry_original_operation"
  | "retry_with_new_operation"
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
  schemaVersion: 1;
  operationId: string;
  boundary: ProvisionDeviceFailureBoundary;
  /** Lifecycle phase last durably recorded for the operation, when any. */
  phaseReached?: string;
  /** Exact identity; a display name alone never authorizes destructive recovery. */
  device?: RecoveryDevice & { ownership: DeviceOwnership | "unknown" };
  outcomes: {
    deviceCreation: "created" | "adopted" | "not_created" | "unknown";
    resultPersistence: "not_attempted" | "unconfirmed" | "unknown";
    /** `release_requested` means the bound session must not be used. */
    session: "none" | "release_requested" | "unknown";
    /** Cancellation boundary only: whether the operation ended within the bounded wait. */
    settlement: "not_applicable" | "settling" | "settled";
  };
  cleanup: {
    status:
      | "unnecessary"
      | "pending"
      | "failed_device_retained"
      | "reported_complete_unverified"
      | "unknown";
    operationId?: string;
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
  operationId: string;
  boundary: ProvisionDeviceFailureBoundary;
  nowMs: number;
  daemonBuild: string;
  lifecycle?: ProvisionDeviceLifecycleOutcome;
  /** Cancellation boundary: did the operation settle within the bounded wait? */
  settled?: boolean;
  originalError?: { code: string; message: string };
  /** Persistence boundary: what the unpersisted result said about the device. */
  result?: {
    created: boolean;
    device?: RecoveryDevice;
    hasSession: boolean;
  };
  retryAfterMs?: number;
  /** Whether this operation created the device or adopted an existing one, when observed. */
  ownership?: DeviceOwnership;
  /** Failure boundaries: the provider's own verdict on whether retrying can help. */
  retryable?: boolean;
  /**
   * False when `lifecycle` was noted in memory only (a cancelled rollback that
   * kept the operation row retryable), so the original operationId is still
   * admitted instead of replaying a stored terminal failure. Defaults to true.
   */
  lifecycleDurable?: boolean;
}

type Cleanup = ProvisionDeviceRecoveryEvidence["cleanup"];

function cleanupFromLifecycle(lifecycle: ProvisionDeviceLifecycleOutcome | undefined): Cleanup {
  if (!lifecycle) {
    return { status: "unknown" };
  }
  const operationId = lifecycle.cleanup?.operationId;
  const withId = (status: Cleanup["status"]): Cleanup =>
    operationId ? { status, operationId } : { status };
  switch (lifecycle.state) {
    case "cleanup_in_progress":
      return withId("pending");
    case "retained":
      return withId("failed_device_retained");
    // A successful destroy command alone does not prove the device is absent.
    case "removed":
      return withId("reported_complete_unverified");
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

/**
 * Lifecycle states the operation row treats as terminal: re-issuing the same
 * operationId replays the stored failure until the row expires instead of
 * starting a new attempt (`provisionDeviceOperationRepository.ts`).
 */
function replaysStoredFailure(input: ProvisionDeviceRecoveryInput): boolean {
  if (input.lifecycleDurable === false) {
    return false;
  }
  switch (input.lifecycle?.state) {
    case "no_device_created":
    case "removed":
    case "cleanup_in_progress":
      return true;
    default:
      return false;
  }
}

function nextAction(
  input: ProvisionDeviceRecoveryInput,
  cleanup: Cleanup,
): ProvisionDeviceRecoveryEvidence["nextAction"] {
  const retryAfterMs = input.retryAfterMs;
  if (input.boundary === "caller_cancellation" && !input.settled) {
    return {
      action: "wait_then_retry_original_operation" as const,
      reason: "Work is still settling; retrying the original operationId converges once it ends.",
      automaticRetrySafe: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  if (cleanup.status === "failed_device_retained") {
    return {
      action: "perform_cleanup" as const,
      reason:
        "Cleanup failed and the device is retained; remove it by its exact identity (not its name) or reacquire it.",
      automaticRetrySafe: false,
    };
  }
  if (input.lifecycle?.state === "created_not_ready" && input.lifecycle.device) {
    return {
      action: "reacquire_retained_device" as const,
      reason:
        "The device was created before the failure; retrying the original operationId adopts it without creating another.",
      automaticRetrySafe: true,
    };
  }
  if (input.boundary === "result_persistence") {
    return {
      action: "retry_original_operation" as const,
      reason:
        "The device outcome is known but the result commit is unconfirmed; replaying the original operationId re-establishes the session without duplicate creation.",
      automaticRetrySafe: true,
    };
  }
  return evidenceGatedRetryAction(input, cleanup);
}

/** The retry path once settling, retained, and persistence evidence are ruled out. */
function evidenceGatedRetryAction(
  input: ProvisionDeviceRecoveryInput,
  cleanup: Cleanup,
): ProvisionDeviceRecoveryEvidence["nextAction"] {
  if (isUnretryableFailureBoundary(input)) {
    return {
      action: "obtain_further_evidence" as const,
      reason:
        "The failure is not marked retryable; inspect the original error and the device inventory before acting.",
      automaticRetrySafe: false,
    };
  }
  if (!input.lifecycle) {
    return {
      action: "obtain_further_evidence" as const,
      reason:
        "No lifecycle evidence was recorded, so the response cannot establish whether a device was created; query inventory before acting.",
      automaticRetrySafe: false,
    };
  }
  if (replaysStoredFailure(input)) {
    return {
      action: "retry_with_new_operation" as const,
      reason:
        cleanup.status === "pending"
          ? "Cleanup is still settling and the original operationId only replays this terminal failure; once it settles, retry with a new operationId."
          : "The operation ended in a terminal state, so the original operationId only replays this failure; retry with a new operationId.",
      // Automatically re-issuing the ORIGINAL operationId can only replay.
      automaticRetrySafe: false,
      ...(cleanup.status === "pending" && input.retryAfterMs !== undefined
        ? { retryAfterMs: input.retryAfterMs }
        : {}),
    };
  }
  return {
    action: "retry_original_operation" as const,
    reason: "Retrying the original operationId resumes the interrupted lifecycle idempotently.",
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

/** The unpersisted result is authoritative for the device outcome. */
function evidenceFromResult(
  result: NonNullable<ProvisionDeviceRecoveryInput["result"]>,
  settlement: DeviceEvidence["outcomes"]["settlement"],
): DeviceEvidence {
  const ownership = result.created ? ("created_by_operation" as const) : ("adopted" as const);
  return {
    ...(result.device ? { device: { ...result.device, ownership } } : {}),
    outcomes: {
      deviceCreation: result.created ? "created" : "adopted",
      resultPersistence: "unconfirmed",
      session: result.hasSession ? "release_requested" : "none",
      settlement,
    },
  };
}

function creationFromLifecycle(
  lifecycle: ProvisionDeviceLifecycleOutcome | undefined,
  ownership: DeviceOwnership | undefined,
): DeviceEvidence["outcomes"]["deviceCreation"] {
  if (lifecycle?.state === "no_device_created") {
    return "not_created";
  }
  // Observed ownership is more precise than the lifecycle state: an adopted
  // device that failed readiness was never created by this operation.
  if (ownership && lifecycle) {
    return ownership === "adopted" ? "adopted" : "created";
  }
  switch (lifecycle?.state) {
    case "created_not_ready":
    case "retained":
    case "cleanup_in_progress":
      return "created";
    default:
      return "unknown";
  }
}

function deviceEvidence(input: ProvisionDeviceRecoveryInput): DeviceEvidence {
  const settlement = settlementFor(input);
  if (input.result) {
    return evidenceFromResult(input.result, settlement);
  }
  const { lifecycle } = input;
  return {
    ...(lifecycle?.device
      ? { device: { ...lifecycle.device, ownership: input.ownership ?? ("unknown" as const) } }
      : {}),
    outcomes: {
      deviceCreation: creationFromLifecycle(lifecycle, input.ownership),
      resultPersistence: "not_attempted",
      session: "unknown",
      settlement,
    },
  };
}

export function buildProvisionDeviceRecoveryEvidence(
  input: ProvisionDeviceRecoveryInput,
): ProvisionDeviceRecoveryEvidence {
  const cleanup = cleanupFromLifecycle(input.lifecycle);
  const { device, outcomes } = deviceEvidence(input);
  return {
    schemaVersion: 1,
    operationId: input.operationId,
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
