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
  isRunnerDeadlineCompletedLate,
  isRunnerFocusQueryFailed,
  isRunnerGestureBoundExceeded,
  isRunnerGestureOutcomeUnknown,
} from "../../../../src/features/observe/ios/runnerErrorCodes";

// The one place the Swift runner's deadline error and the host's reading of it are pinned together
// (the wire fixture decodes in decodeCtrlProxyMessage.test.ts; this reads the Swift source the same
// way that file's ResponseType parity test does). A change to either side fails here.
const swift = readFileSync(
  join(
    import.meta.dir,
    "../../../../ios/control-proxy/Sources/CtrlProxyRewrite/CommandError.swift",
  ),
  "utf8",
);

/** The two `outcome` strings of `case .deadlineExceeded`: [completed, notStarted]. */
function swiftDeadlineOutcomes(): [string, string] {
  const match = /let outcome = gestureCompleted\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/.exec(swift);
  if (!match) {
    throw new Error("Could not locate the deadlineExceeded outcome strings in CommandError.swift");
  }
  return [match[1], match[2]];
}

/** The `wireCode` returned for `gestureCompleted` true / false. */
function swiftDeadlineCodes(): [string, string] {
  const match = /return gestureCompleted\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/.exec(swift);
  if (!match) {
    throw new Error("Could not locate the deadlineExceeded wireCode strings in CommandError.swift");
  }
  return [match[1], match[2]];
}

describe("runner deadline error: Swift CommandError <-> host contract (#10161)", () => {
  test("the Swift wire codes are the TypeScript constants", () => {
    expect(swiftDeadlineCodes()).toEqual([
      RUNNER_DEADLINE_COMPLETED_LATE_CODE,
      RUNNER_DEADLINE_NOT_STARTED_CODE,
    ]);
  });

  test("the wording fallback matches only the completed-late text the Swift runner produces", () => {
    const [completed, notStarted] = swiftDeadlineOutcomes();

    expect(RUNNER_DEADLINE_COMPLETED_LATE_WORDING.test(completed)).toBe(true);
    expect(RUNNER_DEADLINE_COMPLETED_LATE_WORDING.test(notStarted)).toBe(false);
  });

  test("the code decides when present; the wording decides only for a runner without one", () => {
    const [completed, notStarted] = swiftDeadlineOutcomes();
    const text = (outcome: string) =>
      `Command request_swipe exceeded deadline at 5000ms (${outcome})`;

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
        error: text(completed),
      }),
    ).toBe(false);
    expect(isRunnerDeadlineCompletedLate({ error: text(completed) })).toBe(true);
    expect(isRunnerDeadlineCompletedLate({ error: text(notStarted) })).toBe(false);
    expect(isRunnerDeadlineCompletedLate({})).toBe(false);
  });
});

/** The `wireCode` returned for `.gestureBoundExceeded`. */
function swiftGestureBoundCode(): string {
  const match = /case \.gestureBoundExceeded:[\s\S]*?return "([^"]+)"/.exec(swift);
  if (!match) {
    throw new Error("Could not locate the gestureBoundExceeded wireCode in CommandError.swift");
  }
  return match[1];
}

/** `errorDescription` for a bound case, with its interpolations filled in like the runner does. */
function swiftBoundDescription(caseName: "gestureBoundExceeded" | "queryBoundExceeded"): string {
  const match = new RegExp(
    `case let \\.${caseName}\\([^)]*\\):\\s*(?://[^\\n]*\\s*)*return "([^"]+)"`,
  ).exec(swift);
  if (!match) {
    throw new Error(`Could not locate the ${caseName} description in CommandError.swift`);
  }
  const values: Record<string, string> = {
    command: "request_swipe",
    phase: "xcuitestGesture",
    boundMs: "4500",
    elapsedMs: "4502",
  };
  return match[1].replace(/\\\((\w+)\)/g, (_whole, name: string) => values[name] ?? name);
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

// GestureError lives in GesturePerformer.swift; WireError.code(for:) puts its wireCode on the wire.
const gesturePerformerSwift = readFileSync(
  join(
    import.meta.dir,
    "../../../../ios/control-proxy/Sources/CtrlProxyRewrite/GesturePerformer.swift",
  ),
  "utf8",
);

describe("arrow focus-query failure: Swift GestureError <-> host contract (#10924)", () => {
  test("the Swift wire code is the TypeScript constant", () => {
    const match = /case \.focusQueryFailed:[\s\S]*?return "([^"]+)"/.exec(gesturePerformerSwift);
    expect(match?.[1]).toBe(RUNNER_FOCUS_QUERY_FAILED_CODE);
  });

  test("the Swift description says the key was not sent and is not a raw NSException string", () => {
    const match = /case let \.focusQueryFailed\(phase, detail\):\s*return "([^"]+)"/.exec(
      gesturePerformerSwift,
    );
    expect(match?.[1]).toStartWith("arrow key was not sent: ");
    expect(match?.[1]).not.toContain("NSException(");
  });

  test("only the code identifies the failure", () => {
    expect(isRunnerFocusQueryFailed({ errorCode: RUNNER_FOCUS_QUERY_FAILED_CODE })).toBe(true);
    expect(isRunnerFocusQueryFailed({ errorCode: RUNNER_GESTURE_BOUND_EXCEEDED_CODE })).toBe(false);
    expect(isRunnerFocusQueryFailed({})).toBe(false);
  });
});
