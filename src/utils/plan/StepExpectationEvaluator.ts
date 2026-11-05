import { classifyToolResult } from "../toolEnvelopePayload";
import { getStructuredPayload } from "../toolUtils";
import { errorMessage } from "../describeUnknownError";
import { isDeviceLostError } from "../../models/DeviceLostError";
import type { FailureObservationSummary } from "../../models/FailureObservation";
import { waitForTimeoutDiagnostics, waitForTimeoutError } from "./waitForTimeout";
import { summarizeObserveResultForFailure } from "./summarizeFailureObservation";
import {
  expectationFailureMessage,
  expectationQuery,
  unsupportedExpectationWarning,
} from "./stepExpectations";

/** Runs one fresh, internal `observe` with this `waitFor` on the step's device. */
export type ExpectationObserve = (waitFor: Record<string, unknown>) => Promise<unknown>;

export type StepExpectationOutcome =
  | { status: "passed"; warnings?: string[] }
  | {
      status: "failed";
      error: string;
      /** Merged into the step's `details`: the failing expectation and what its observe saw. */
      details: Record<string, unknown>;
      failureObservation?: FailureObservationSummary;
      warnings?: string[];
    };

interface Position {
  index: number;
  total: number;
  label: string;
}

/** The unwrapped observe payload, or the failure message the observe returned instead. */
function observePayload(
  response: unknown,
): { payload: Record<string, unknown> } | { error: string } {
  const result = classifyToolResult(response, "observe");
  if ("failure" in result && result.failure) {
    const failure = result.failure;
    return { error: typeof failure.error === "string" ? failure.error : "observe failed" };
  }
  if (result.kind !== "payload") {
    return { error: "observe returned no observation" };
  }
  const payload = getStructuredPayload<Record<string, unknown>>(result.payload) ?? result.payload;
  if (payload.success === false) {
    return { error: typeof payload.error === "string" ? payload.error : "observe failed" };
  }
  return { payload };
}

function failed(
  position: Position,
  expectation: unknown,
  reason: string,
  extra: {
    failureObservation?: FailureObservationSummary;
    waitForTimeout?: Record<string, unknown>;
  } = {},
): Extract<StepExpectationOutcome, { status: "failed" }> {
  const { failureObservation, waitForTimeout } = extra;
  const error = expectationFailureMessage(position, reason, {
    visibleTexts: failureObservation?.visibleTextsSample,
    candidateCount:
      typeof waitForTimeout?.candidateCount === "number"
        ? waitForTimeout.candidateCount
        : undefined,
  });
  return {
    status: "failed",
    error,
    details: {
      error,
      failedExpectation: { index: position.index, expectation },
      ...(waitForTimeout ? { waitForTimeout } : {}),
      ...(failureObservation ? { failureObservation } : {}),
    },
    ...(failureObservation ? { failureObservation } : {}),
  };
}

async function evaluateOne(
  observe: ExpectationObserve,
  position: Position,
  expectation: unknown,
  waitFor: Record<string, unknown>,
): Promise<Extract<StepExpectationOutcome, { status: "failed" }> | undefined> {
  let response: unknown;
  try {
    response = await observe(waitFor);
  } catch (error) {
    if (isDeviceLostError(error)) {
      throw error;
    }
    return failed(position, expectation, `could not observe the screen: ${errorMessage(error)}`);
  }
  const outcome = observePayload(response);
  if ("error" in outcome) {
    return failed(position, expectation, `could not observe the screen: ${outcome.error}`);
  }
  const timedOut = waitForTimeoutError(outcome.payload, "observe");
  if (timedOut === null) {
    return undefined;
  }
  const waited = outcome.payload.awaitDuration;
  return failed(
    position,
    expectation,
    `not satisfied after ${typeof waited === "number" ? waited : "unknown"}ms`,
    {
      failureObservation: summarizeObserveResultForFailure(outcome.payload),
      waitForTimeout: waitForTimeoutDiagnostics(outcome.payload),
    },
  );
}

/**
 * Check a completed step's expectations in order against fresh observations; the first one that
 * fails (or cannot be evaluated) fails the step. Unsupported types are reported as warnings.
 */
export async function evaluateStepExpectations(
  expectations: readonly unknown[],
  observe: ExpectationObserve,
): Promise<StepExpectationOutcome> {
  const warnings: string[] = [];
  const total = expectations.length;
  for (const [index, expectation] of expectations.entries()) {
    const query = expectationQuery(expectation);
    const position = { index, total, label: query.label };
    if (query.kind === "unsupported") {
      warnings.push(unsupportedExpectationWarning(query));
      continue;
    }
    const failure =
      query.kind === "invalid"
        ? failed(position, expectation, `invalid expectation: ${query.error}`)
        : await evaluateOne(observe, position, expectation, query.waitFor);
    if (failure) {
      return warnings.length > 0 ? { ...failure, warnings } : failure;
    }
  }
  return warnings.length > 0 ? { status: "passed", warnings } : { status: "passed" };
}
