import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  RUNNER_DEADLINE_COMPLETED_LATE_CODE,
  RUNNER_DEADLINE_COMPLETED_LATE_WORDING,
  RUNNER_DEADLINE_NOT_STARTED_CODE,
  RUNNER_FOCUS_QUERY_FAILED_CODE,
  RUNNER_GESTURE_BOUND_EXCEEDED_CODE,
  RUNNER_GESTURE_BOUND_EXCEEDED_WORDING,
  RUNNER_HIERARCHY_CAPTURE_FAILED_CODE,
  isRunnerDeadlineCompletedLate,
  isRunnerFocusQueryFailed,
  isRunnerGestureBoundExceeded,
  isRunnerGestureOutcomeUnknown,
  isRunnerHierarchyCaptureFailed,
} from "../../../../src/features/observe/ios/runnerErrorCodes";

// Captured from production Swift encoders; Swift also checks this oracle without regeneration.
const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/ios-contract/runner-responses.json"),
    "utf8",
  ),
) as { commandErrors: { name: string; error: string; errorCode: string | null }[] };

function runnerError(name: string) {
  const error = fixture.commandErrors.find((entry) => entry.name === name);
  if (!error) {
    throw new Error(`Missing Swift error fixture: ${name}`);
  }
  return error;
}

function swiftDeadlineDescriptions(): [string, string] {
  return [runnerError("deadline_completed_late").error, runnerError("deadline_not_started").error];
}

function swiftDeadlineCodes(): [string | null, string | null] {
  return [
    runnerError("deadline_completed_late").errorCode,
    runnerError("deadline_not_started").errorCode,
  ];
}

describe("runner deadline error: Swift CommandError <-> host contract (#10161)", () => {
  test("the Swift wire codes are the TypeScript constants", () => {
    expect(swiftDeadlineCodes()).toEqual([
      RUNNER_DEADLINE_COMPLETED_LATE_CODE,
      RUNNER_DEADLINE_NOT_STARTED_CODE,
    ]);
  });

  test("the wording fallback matches only the completed-late text the Swift runner produces", () => {
    const [completed, notStarted] = swiftDeadlineDescriptions();

    expect(RUNNER_DEADLINE_COMPLETED_LATE_WORDING.test(completed)).toBe(true);
    expect(RUNNER_DEADLINE_COMPLETED_LATE_WORDING.test(notStarted)).toBe(false);
  });

  test("the code decides when present; the wording decides only for a runner without one", () => {
    const [completed, notStarted] = swiftDeadlineDescriptions();

    expect(isRunnerDeadlineCompletedLate({ errorCode: RUNNER_DEADLINE_COMPLETED_LATE_CODE })).toBe(
      true,
    );
    expect(isRunnerDeadlineCompletedLate({ errorCode: RUNNER_DEADLINE_NOT_STARTED_CODE })).toBe(
      false,
    );
    // A present code outranks contradicting text.
    expect(
      isRunnerDeadlineCompletedLate({
        errorCode: RUNNER_DEADLINE_NOT_STARTED_CODE,
        error: completed,
      }),
    ).toBe(false);
    expect(isRunnerDeadlineCompletedLate({ error: completed })).toBe(true);
    expect(isRunnerDeadlineCompletedLate({ error: notStarted })).toBe(false);
    expect(isRunnerDeadlineCompletedLate({})).toBe(false);
  });
});

function swiftGestureBoundCode(): string | null {
  return runnerError("gesture_bound_exceeded").errorCode;
}

function swiftBoundDescription(caseName: "gestureBoundExceeded" | "queryBoundExceeded"): string {
  return runnerError(
    caseName === "gestureBoundExceeded" ? "gesture_bound_exceeded" : "query_bound_exceeded",
  ).error;
}

describe("runner gesture-bound error: Swift CommandError <-> host contract (#10016)", () => {
  test("the Swift wire code is the TypeScript constant", () => {
    expect(swiftGestureBoundCode()).toBe(RUNNER_GESTURE_BOUND_EXCEEDED_CODE);
  });

  test("the wording fallback matches the gesture bound and not the query bound", () => {
    const gesture = swiftBoundDescription("gestureBoundExceeded");
    const query = swiftBoundDescription("queryBoundExceeded");

    expect(gesture).toContain("exceeded execution bound 4500ms in phase xcuitestGesture");
    expect(RUNNER_GESTURE_BOUND_EXCEEDED_WORDING.test(gesture)).toBe(true);
    expect(RUNNER_GESTURE_BOUND_EXCEEDED_WORDING.test(query)).toBe(false);
  });

  test("the code decides when present; the wording decides only for a runner without one", () => {
    const gesture = swiftBoundDescription("gestureBoundExceeded");

    expect(isRunnerGestureBoundExceeded({ errorCode: RUNNER_GESTURE_BOUND_EXCEEDED_CODE })).toBe(
      true,
    );
    expect(
      isRunnerGestureBoundExceeded({ errorCode: RUNNER_DEADLINE_NOT_STARTED_CODE, error: gesture }),
    ).toBe(false);
    expect(isRunnerGestureBoundExceeded({ error: gesture })).toBe(true);
    expect(isRunnerGestureBoundExceeded({})).toBe(false);
  });

  test("either unknown-outcome reply counts; a gesture never started does not", () => {
    expect(isRunnerGestureOutcomeUnknown({ errorCode: RUNNER_GESTURE_BOUND_EXCEEDED_CODE })).toBe(
      true,
    );
    expect(isRunnerGestureOutcomeUnknown({ errorCode: RUNNER_DEADLINE_COMPLETED_LATE_CODE })).toBe(
      true,
    );
    expect(isRunnerGestureOutcomeUnknown({ errorCode: RUNNER_DEADLINE_NOT_STARTED_CODE })).toBe(
      false,
    );
  });
});

describe("arrow focus-query failure: Swift GestureError <-> host contract (#10924)", () => {
  test("the Swift wire code is the TypeScript constant", () => {
    expect(runnerError("focus_query_failed").errorCode).toBe(RUNNER_FOCUS_QUERY_FAILED_CODE);
  });

  test("the Swift description says the key was not sent and is not a raw NSException string", () => {
    const description = runnerError("focus_query_failed").error;
    expect(description).toStartWith("arrow key was not sent: ");
    expect(description).not.toContain("NSException(");
  });

  test("only the code identifies the failure", () => {
    expect(isRunnerFocusQueryFailed({ errorCode: RUNNER_FOCUS_QUERY_FAILED_CODE })).toBe(true);
    expect(isRunnerFocusQueryFailed({ errorCode: RUNNER_GESTURE_BOUND_EXCEEDED_CODE })).toBe(false);
    expect(isRunnerFocusQueryFailed({})).toBe(false);
  });
});

describe("hierarchy capture failure: Swift CommandError <-> host contract (#11886)", () => {
  test("the Swift wire code is the TypeScript constant", () => {
    expect(runnerError("hierarchy_capture_failed").errorCode).toBe("hierarchy_capture_failed");
    expect(runnerError("hierarchy_capture_failed").errorCode).toBe(
      RUNNER_HIERARCHY_CAPTURE_FAILED_CODE,
    );
  });

  test("the Swift description says the gesture was not sent and cannot imply stale or unknown outcome", () => {
    const description = runnerError("hierarchy_capture_failed").error;
    expect(description).toContain("validate the frame context");
    expect(description).toContain("the gesture was not sent");
    expect(description).toContain("fixture reason");
    expect(description).not.toMatch(/stale/i);
    expect(description).not.toMatch(/stale frame context/i);
    expect(description).not.toMatch(RUNNER_DEADLINE_COMPLETED_LATE_WORDING);
    expect(description).not.toMatch(RUNNER_GESTURE_BOUND_EXCEEDED_WORDING);
  });

  test("only the code identifies the failure", () => {
    expect(
      isRunnerHierarchyCaptureFailed({ errorCode: RUNNER_HIERARCHY_CAPTURE_FAILED_CODE }),
    ).toBe(true);
    for (const errorCode of [
      RUNNER_DEADLINE_COMPLETED_LATE_CODE,
      RUNNER_DEADLINE_NOT_STARTED_CODE,
      RUNNER_GESTURE_BOUND_EXCEEDED_CODE,
      RUNNER_FOCUS_QUERY_FAILED_CODE,
      "unknown_code",
      "",
    ]) {
      expect(isRunnerHierarchyCaptureFailed({ errorCode })).toBe(false);
    }
    expect(isRunnerHierarchyCaptureFailed({})).toBe(false);
  });
});
