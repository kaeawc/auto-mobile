import { describe, expect, test } from "bun:test";
import { formatSwipeOnMessage } from "../../src/server/interactionTools";

describe("formatSwipeOnMessage", () => {
  test("reports non-throwing swipe failures instead of a completed swipe", () => {
    expect(formatSwipeOnMessage({
      success: false,
      error: "VoiceOver scrolling is not supported"
    }, "up")).toBe("VoiceOver scrolling is not supported");
  });

  test("preserves the successful scroll message", () => {
    expect(formatSwipeOnMessage({
      success: true,
      found: true,
      scrollIterations: 2
    }, "up")).toBe("Swiped up and found element after 2 swipe(s)");
  });
});
