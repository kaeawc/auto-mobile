import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  RUNNER_DEADLINE_COMPLETED_LATE_CODE,
  RUNNER_DEADLINE_COMPLETED_LATE_WORDING,
  RUNNER_DEADLINE_NOT_STARTED_CODE,
  isRunnerDeadlineCompletedLate,
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
