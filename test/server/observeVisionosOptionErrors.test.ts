import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models";
import { assertWatchObserveOptions } from "../../src/server/observeWatch";

function refusal(run: () => void): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ActionableError);
    return (error as ActionableError).message;
  }
  throw new Error("expected observe options to be refused");
}

// The garbled messages the #16854 visionOS dogfood run captured (#18016):
//   observe --screenshot none
//   Error: observe with the visionOS runner and does not support: screenshot: "none". Remove these options and observe again.
//   observe --raw true
//   Error: observe with the visionOS runner and does not support: raw. Remove these options and observe again.
describe("observe option refusals on visionOS (#18016)", () => {
  test("screenshot none with the runner names the option and the screenshot modes to use", () => {
    expect(
      refusal(() => assertWatchObserveOptions({ screenshot: "none" }, "0", "visionos", true)),
    ).toBe(
      'observe with the visionOS runner does not support: screenshot: "none". ' +
        'Instead, use screenshot: "settled" or "async" (every observe here returns a screenshot). ' +
        "Remove the unsupported options and observe again.",
    );
  });

  test("raw with the runner names the option and points at the full projection", () => {
    expect(refusal(() => assertWatchObserveOptions({ raw: true }, "0", "visionos", true))).toBe(
      "observe with the visionOS runner does not support: raw. " +
        'Instead, omit raw and use project: "full" for every element. ' +
        "Remove the unsupported options and observe again.",
    );
  });

  test("several refused options are each named once, with each alternative", () => {
    const message = refusal(() =>
      assertWatchObserveOptions(
        { screenshot: "none", raw: true, display: "cover" },
        "0",
        "visionos",
        true,
      ),
    );
    expect(message).toBe(
      'observe with the visionOS runner does not support: raw, screenshot: "none", display: "cover". ' +
        'Instead, omit raw and use project: "full" for every element; ' +
        'use screenshot: "settled" or "async" (every observe here returns a screenshot); ' +
        'use display: "active" or "0". Remove the unsupported options and observe again.',
    );
    expect(message).not.toContain("runner and does not support");
  });

  test("without the runner, raw has no alternative and the screenshot-only reason is kept", () => {
    expect(
      refusal(() =>
        assertWatchObserveOptions({ raw: true, screenshot: "none" }, "0", "visionos", false),
      ),
    ).toBe(
      "observe on visionOS returns only a screenshot (the view hierarchy is not available yet) " +
        'and does not support: raw, screenshot: "none". ' +
        'Instead, use screenshot: "settled" or "async" (every observe here returns a screenshot). ' +
        "Remove the unsupported options and observe again.",
    );
  });

  test("the supported screenshot modes are accepted", () => {
    for (const screenshot of ["settled", "async"] as const) {
      expect(() => assertWatchObserveOptions({ screenshot }, "0", "visionos", true)).not.toThrow();
    }
  });
});
