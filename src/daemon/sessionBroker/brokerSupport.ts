import { ResetCapacityWaitExceededError } from "../../models/ResetCapacityWaitExceededError";
import { classifyCleanReleaseError } from "./cleanReleaseFailure";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import type { SessionConfig } from "../../devices/sessionConfig";
import type { SessionBrokerFailure, SessionBrokerResult } from "../../devices/sessionBrokerResult";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { BindingProcessIdentity } from "./registry/bindingRegistry";
import { SessionBrokerFailureError } from "./devicePort";
import { BindingRegistrySchemaUnsupportedError } from "./provisioning/BindingRegistrySchemaUnsupportedError";
import { SessionBrokerStoppingError } from "./SessionBrokerStoppingError";
import { SESSION_BROKER_RETRY_AFTER_MS } from "./timing";
import type { BrokerRequestRecord, BrokerResourceRecord } from "./store";
import { nativeProfile } from "./profile";
import { sessionReadiness } from "./watchAdmission";
import { SESSION_REQUEST_ABANDONED_CODE } from "./requestIdentity";

export function storedBrokerFailure(
  request: BrokerRequestRecord,
  cleanupPending: boolean,
): SessionBrokerFailure {
  const code = request.errorCode ?? "session_preparation_failed";
  const retryable =
    request.retryable &&
    (["eviction_pending", "session_broker_stopping"].includes(code) || !cleanupPending);
  return {
    code,
    message: request.error ?? "",
    retryable,
    ...(retryable && code === "eviction_pending" ? { retryAfterMs: 1_000 } : {}),
    ...(retryable && code === "session_broker_stopping"
      ? { retryAfterMs: SESSION_BROKER_RETRY_AFTER_MS }
      : {}),
    ...(retryable &&
    ["capacity_exhausted", "cancelled", "eviction_pending", "session_broker_stopping"].includes(
      code,
    )
      ? { retryRequires: "new_request_id" as const }
      : {}),
  };
}

export { unwrap } from "./devicePort";

export function failureFor(error: unknown): SessionBrokerFailure {
  if (error instanceof BindingRegistrySchemaUnsupportedError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      remedy: error.remedy,
      writerVersions: error.writerVersions,
    };
  }
  return error instanceof SessionBrokerFailureError
    ? error.failure
    : { code: "session_preparation_failed", message: errorMessage(error), retryable: false };
}

export function abortedByBrokerStop(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof SessionBrokerStoppingError;
}

export function preparationFailureError(error: unknown, signal: AbortSignal): unknown {
  if (abortedByBrokerStop(signal)) {
    return new SessionBrokerFailureError({
      code: "session_broker_stopping",
      retryable: true,
      retryAfterMs: SESSION_BROKER_RETRY_AFTER_MS,
      retryRequires: "new_request_id",
      message:
        "Session preparation was interrupted because the session broker is stopping; retry with a new request ID against the restarted daemon.",
    });
  }
  if (error instanceof SessionBrokerFailureError || !signal.aborted) {
    return error;
  }
  return new SessionBrokerFailureError({
    code: "cancelled",
    retryable: true,
    message: `Session preparation was cancelled: ${errorMessage(signal.reason)}`,
  });
}

export function failedResult(
  config: SessionConfig,
  failure: SessionBrokerFailure,
): SessionBrokerResult {
  return {
    contractVersion: 1,
    requestId: config.requestId,
    outcome: "failed",
    sessionUuid: null,
    profile: null,
    cleanupPending: false,
    failure,
  };
}

export function sameProcess(left: BindingProcessIdentity, right: BindingProcessIdentity): boolean {
  return (
    left.daemonId === right.daemonId &&
    left.pid === right.pid &&
    left.processGenerationToken === right.processGenerationToken
  );
}

export function drainFailureOutcome(
  error: unknown,
  sessionUuid: string,
  resetClean: boolean,
): "destroy" | "pending" {
  // Reset capacity exhaustion is terminal after its bounded wait. Other admission
  // refusals stay pending for recovery; the consumer's release is already durable.
  if (error instanceof ResetCapacityWaitExceededError) {
    logger.warn(`Session ${sessionUuid} clean release exhausted capacity wait: ${error.message}`);
    return "destroy";
  }
  if (error instanceof BootCapacityExhaustedError) {
    logger.warn(
      `Session ${sessionUuid} clean release awaits boot capacity: ${errorMessage(error)}`,
    );
    return "pending";
  }
  // A discovery_incomplete gate sample stays pending so recovery can retry discovery.
  // Native execution/journal fences still prevent destructive work before the drain joins.
  logger.warn(`Session ${sessionUuid} could not finish its clean release: ${errorMessage(error)}`);
  const kind = classifyCleanReleaseError(error);
  if (kind === "permanent" || (!resetClean && kind === "unknown")) {
    return "destroy";
  }
  // A clean baseline survives unknown receipt-write failures; earlier failures need a
  // known retryable kind. recover()/service redrive bounds each pass, not total retries:
  // no per-request attempt/time cap exists, so persistent failures can stay pending forever.
  return "pending";
}

export function brokerResult(
  request: BrokerRequestRecord,
  resource: BrokerResourceRecord | undefined,
  hasPendingPreparation: boolean,
): SessionBrokerResult {
  const durableCleanupPending =
    resource?.requestId === request.requestId &&
    ["destroying", "resetting", "unknown"].includes(resource.state);
  const preparationPending =
    request.errorCode === SESSION_REQUEST_ABANDONED_CODE && hasPendingPreparation;
  const cleanupPending = Boolean(durableCleanupPending || preparationPending);
  return {
    contractVersion: 1,
    requestId: request.requestId,
    outcome:
      request.state === "active"
        ? "ready"
        : request.state === "failed"
          ? "failed"
          : request.state === "released"
            ? "released"
            : "pending",
    sessionUuid: request.sessionId,
    profile: resource ? nativeProfile(resource) : null,
    ...sessionReadiness(request.state === "active", resource),
    cleanupPending,
    ...(request.timing ? { timing: request.timing } : {}),
    ...(request.error ? { failure: storedBrokerFailure(request, cleanupPending) } : {}),
  };
}

export function failedPreparationResult(
  request: BrokerRequestRecord,
  result: SessionBrokerResult,
  failure: SessionBrokerFailure,
): SessionBrokerResult {
  return request.errorCode === SESSION_REQUEST_ABANDONED_CODE
    ? result
    : {
        ...result,
        failure: {
          ...failure,
          retryable: Boolean(result.failure?.retryable),
          // The stored receipt owns retry guidance, so the first reply matches every replay.
          ...(result.failure?.retryAfterMs !== undefined
            ? { retryAfterMs: result.failure.retryAfterMs }
            : {}),
          ...(result.failure?.retryRequires ? { retryRequires: result.failure.retryRequires } : {}),
        },
      };
}
