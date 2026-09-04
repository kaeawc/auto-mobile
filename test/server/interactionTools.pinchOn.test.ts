import { describe, expect, test } from "bun:test";
import { formatPinchOnMessage } from "../../src/server/interactionTools";

// Mirrors interactionTools.swipeOn.test.ts for the pinchOn message fix (#6056).
// Before the fix, pinchOnHandler hardcoded `Pinched ${direction}` regardless of
// outcome, so a validation failure (e.g. scale:0 -> success:false, error:"scale
// must be greater than 0") still reported a success-shaped message. The helper
// did not exist; these failure assertions could not have passed against the old
// hardcoded behavior.
describe("formatPinchOnMessage", () => {
  test("reports the failure error instead of a completed pinch", () => {
    const message = formatPinchOnMessage(
      {
        success: false,
        error: "scale must be greater than 0",
      },
      "in",
    );
    expect(message).toBe("scale must be greater than 0");
    expect(message).not.toBe("Pinched in");
  });

  test("preserves the successful pinch message", () => {
    expect(formatPinchOnMessage({ success: true }, "out")).toBe("Pinched out");
  });

  // Table is the spec: the failure branch must always produce a non-empty
  // message. The `error: ""` row is the `||`-not-`??` case — `??` would let an
  // empty string through, returning a blank tool message (#4183 P4).
  test.each([
    [{ success: false as const, error: "boom" }, "in", "boom"],
    [{ success: false as const }, "in", "Pinch in failed"],
    [{ success: false as const, error: "" }, "out", "Pinch out failed"],
    [{ success: false as const, error: undefined }, "out", "Pinch out failed"],
  ])("failure %o yields %p", (result, direction, expected) => {
    const message = formatPinchOnMessage(result, direction);
    expect(message).toBe(expected);
    expect(message.length).toBeGreaterThan(0);
  });

  test.each([
    [{ success: true as const }, "in", "Pinched in"],
    [{ success: true as const }, "out", "Pinched out"],
  ])("success %o yields %p", (result, direction, expected) => {
    expect(formatPinchOnMessage(result, direction)).toBe(expected);
  });
});
