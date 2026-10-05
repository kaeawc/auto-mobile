import { describe, expect, test } from "bun:test";
import { waitForTimeoutError } from "../../../src/utils/plan/waitForTimeout";

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
