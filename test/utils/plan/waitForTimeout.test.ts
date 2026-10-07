import { describe, expect, test } from "bun:test";
import {
  waitForTimeoutDiagnostics,
  waitForTimeoutError,
} from "../../../src/utils/plan/waitForTimeout";

describe("waitForTimeoutError", () => {
  test.each(["observe", "openLink", "futureWaitTool"])(
    "names %s and its reported duration",
    (tool) => {
      expect(
        waitForTimeoutError({ success: true, awaitTimeout: true, awaitDuration: 5000 }, tool),
      ).toBe(`${tool} waitFor timed out after 5000ms`);
    },
  );

  test.each([undefined, "5000"])("uses unknown for a nonnumeric duration %s", (awaitDuration) => {
    expect(waitForTimeoutError({ awaitTimeout: true, awaitDuration }, "observe")).toBe(
      "observe waitFor timed out after unknownms",
    );
  });

  test("preserves zero duration and does not require matched false", () => {
    expect(
      waitForTimeoutError({ awaitTimeout: true, matched: true, awaitDuration: 0 }, "openLink"),
    ).toBe("openLink waitFor timed out after 0ms");
  });

  test.each([
    undefined,
    null,
    "awaitTimeout",
    { success: true },
    { awaitTimeout: false, matched: true },
    { awaitTimeout: 5000, timedOut: true, matched: false },
    { awaitTimeout: "true" },
    { timedOut: true, matched: false },
    { params: { awaitTimeout: true } },
    { structuredContent: { awaitTimeout: true } },
  ])("ignores absent, satisfied, input, or unrelated timeout metadata: %j", (payload) => {
    expect(waitForTimeoutError(payload, "systemTray")).toBeNull();
  });
});

describe("waitForTimeoutDiagnostics", () => {
  test("keeps the wait scalars and caps candidates to identifying fields", () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      text: `c${i}`,
      bounds: { left: i },
      node: [{ deep: true }],
    }));
    expect(
      waitForTimeoutDiagnostics({
        awaitTimeout: true,
        awaitDuration: 50,
        timedOut: true,
        matched: false,
        timeoutReason: "posture",
        candidates,
        elements: { text: [] },
      }),
    ).toEqual({
      awaitDuration: 50,
      timedOut: true,
      matched: false,
      timeoutReason: "posture",
      candidates: candidates.slice(0, 5).map(({ text, bounds }) => ({ text, bounds })),
      candidateCount: 8,
    });
  });

  test.each([undefined, null, { awaitTimeout: false, awaitDuration: 5 }, { awaitDuration: 5 }])(
    "is undefined for a non-timeout payload: %j",
    (payload) => {
      expect(waitForTimeoutDiagnostics(payload)).toBeUndefined();
    },
  );

  test("is undefined when the timeout carries no diagnostics", () => {
    expect(waitForTimeoutDiagnostics({ awaitTimeout: true })).toBeUndefined();
  });
});
