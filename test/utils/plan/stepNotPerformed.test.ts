import { describe, expect, test } from "bun:test";
import { stepNotPerformedError } from "../../../src/utils/plan/stepNotPerformed";

describe("stepNotPerformedError", () => {
  test("returns the tool's own message for an unsupported result", () => {
    expect(
      stepNotPerformedError(
        { status: "unsupported", message: "This iOS simulator is not a foldable device." },
        "setPosture",
      ),
    ).toBe("This iOS simulator is not a foldable device.");
  });

  test("falls back to a generic message when the tool gave none", () => {
    expect(stepNotPerformedError({ status: "unsupported" }, "setPosture")).toBe(
      "setPosture is not supported here; nothing was changed",
    );
    expect(stepNotPerformedError({ status: "unsupported", message: "  " }, "setPosture")).toBe(
      "setPosture is not supported here; nothing was changed",
    );
  });

  test("ignores every payload that is not an unsupported refusal", () => {
    const others: unknown[] = [
      undefined,
      null,
      "unsupported",
      42,
      [],
      {},
      { status: "ok" },
      { status: "skipped", message: "already set" },
      { success: true, posture: "closed" },
      { unsupported: true },
    ];
    for (const payload of others) {
      expect(stepNotPerformedError(payload, "setPosture")).toBeNull();
    }
  });
});
