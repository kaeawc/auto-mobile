import { describe, expect, test } from "bun:test";
import { formatSwipeOnMessage } from "../../src/server/interactionTools";

describe("formatSwipeOnMessage", () => {
  test("reports non-throwing swipe failures instead of a completed swipe", () => {
    expect(
      formatSwipeOnMessage(
        {
          success: false,
          error: "VoiceOver scrolling is not supported",
        },
        "up",
      ),
    ).toBe("VoiceOver scrolling is not supported");
  });

  test("preserves the successful scroll message", () => {
    expect(
      formatSwipeOnMessage(
        {
          success: true,
          found: true,
          scrollIterations: 2,
        },
        "up",
      ),
    ).toBe("Swiped up and found element after 2 swipe(s)");
  });

  // Table is the spec: the failure branch must always produce a non-empty
  // message. Row 3 (`error: ""`) is the live bug — `??` let an empty string
  // through, returning a blank tool message (#4183 P4).
  test.each([
    [{ success: false as const, error: "boom" }, "left", "boom"],
    [{ success: false as const }, "left", "Swipe left failed"],
    [{ success: false as const, error: "" }, "down", "Swipe down failed"],
    [{ success: false as const, error: undefined }, "right", "Swipe right failed"],
  ])("failure %o yields %p", (result, direction, expected) => {
    const message = formatSwipeOnMessage(result, direction);
    expect(message).toBe(expected);
    expect(message.length).toBeGreaterThan(0);
  });

  test.each([
    [{ success: true as const, found: false }, "up", "Swiped up"],
    [{ success: true as const, found: true }, "up", "Swiped up and found element after 1 swipe(s)"],
  ])("success %o yields %p", (result, direction, expected) => {
    expect(formatSwipeOnMessage(result, direction)).toBe(expected);
  });
});
