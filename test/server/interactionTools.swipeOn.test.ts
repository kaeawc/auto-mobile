import { afterEach, describe, expect, test } from "bun:test";
import {
  formatSwipeOnMessage,
  resetSwipeOnFactory,
  setSwipeOnFactory,
  swipeOnHandler,
} from "../../src/server/interactionTools";
import type { SwipeOnArgs } from "../../src/server/interactionToolTypes";
import type { BootedDevice, SwipeOnToolPayload } from "../../src/models";
import { getStructuredField } from "../../src/utils/toolUtils";

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

// Handler-level coverage: exercise the REGISTERED swipeOn handler path (not
// just the formatter) with an injected fake SwipeOn, and assert the serialized
// envelope carries `isError: true` on failure. Before #6163 the message was
// already outcome-gated but the envelope never set `isError`, so a conforming
// client still saw an ordinary result on a failed swipe.
describe("swipeOnHandler (registered handler wiring)", () => {
  const fakeDevice = { deviceId: "fake", platform: "android" } as unknown as BootedDevice;
  const args: SwipeOnArgs = { direction: "up", platform: "android" };

  afterEach(() => {
    resetSwipeOnFactory();
  });

  const fakeResult = (overrides: Partial<SwipeOnToolPayload>): SwipeOnToolPayload =>
    ({
      success: false,
      ...overrides,
    }) as SwipeOnToolPayload;

  test("a failed swipe sets isError and reports the failure, not a completed swipe", async () => {
    setSwipeOnFactory(() => ({
      execute: async () => fakeResult({ error: "VoiceOver scrolling is not supported" }),
    }));

    const response = await swipeOnHandler(fakeDevice, args);
    expect(response.isError).toBe(true);
    expect(getStructuredField(response, "message")).toBe("VoiceOver scrolling is not supported");
    expect(getStructuredField(response, "success")).toBe(false);
  });

  test("a successful swipe has no isError and an unchanged message", async () => {
    setSwipeOnFactory(() => ({
      execute: async () => fakeResult({ success: true, found: false }),
    }));

    const response = await swipeOnHandler(fakeDevice, args);
    expect(response.isError).toBeUndefined();
    expect(getStructuredField(response, "message")).toBe("Swiped up");
  });
});
