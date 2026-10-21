import { classifyCleanReleaseError } from "./cleanReleaseFailure";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import type { RequirementResult } from "../../devices/sessionRequirements";
import type { SessionConfig } from "../../devices/sessionConfig";
import type { SessionBrokerFailure, SessionBrokerResult } from "../../devices/sessionBrokerResult";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { BindingProcessIdentity } from "./registry/bindingRegistry";
import { SessionBrokerFailureError } from "./devicePort";

export function unwrap<T>(result: RequirementResult<T>): T {
  if (!result.ok) {
    throw new SessionBrokerFailureError({
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.transient,
    });
  }
  return result.value;
}

export function failureFor(error: unknown): SessionBrokerFailure {
  return error instanceof SessionBrokerFailureError
    ? error.failure
    : { code: "session_preparation_failed", message: errorMessage(error), retryable: false };
}

export function preparationFailureError(error: unknown, signal: AbortSignal): unknown {
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
  // Admission refusal leaves a healthy erased simulator shut down. Keep the durable reset
  // pending and let recovery retry it; the consumer's release is already durable.
  if (error instanceof BootCapacityExhaustedError) {
    logger.warn(
      `Session ${sessionUuid} clean release awaits boot capacity: ${errorMessage(error)}`,
    );
    return "pending";
  }
  // A failed or timed-out gate sample is not a capacity refusal and falls through to destruction.
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
