import { describe, expect, test } from "bun:test";
import {
  createSwipeAtHandler,
  swipeAtSchema,
  type SwipeAtElementLike,
} from "../../src/server/swipeAtTools";
import type { BootedDevice, SwipeAtOptions, SwipeResult } from "../../src/models";
import { getStructuredField } from "../../src/utils/toolUtils";

const device: BootedDevice = { deviceId: "swipe-at-tool", platform: "android", name: "Fake" };
const imageSource = {
  screenshot: { screenSize: { width: 100, height: 200 }, screenshotOrientation: "display" },
} as const;

function handlerFor(execute: SwipeAtElementLike["execute"]) {
  return createSwipeAtHandler({ swipeAtFactory: () => ({ execute }) });
}

describe("swipeAtSchema", () => {
  test.each([
    ["absolute from/to", { platform: "android", from: { x: 1, y: 2 }, to: { x: 30, y: 40 } }],
    [
      "normalized from/to",
      {
        platform: "ios",
        from: { x: 0, y: 0.5 },
        to: { x: 1, y: 0.5 },
        coordinateSpace: "normalized",
      },
    ],
    [
      "percent from/to with speed, layer and snapshot",
      {
        platform: "android",
        from: { x: 10, y: 90 },
        to: { x: 80, y: 20 },
        coordinateSpace: "percent",
        speed: "fast",
        layer: "app",
        snapshotId: "snapshot-1",
      },
    ],
    [
      "from/to on a selected display",
      { platform: "android", from: { x: 1, y: 2 }, to: { x: 30, y: 40 }, display: "cover" },
    ],
    [
      "image-relative from/to",
      {
        platform: "android",
        image: {
          unit: "normalized",
          source: imageSource,
          from: { x: 0.1, y: 0.1 },
          to: { x: 0.9, y: 0.6 },
        },
      },
    ],
  ])("accepts %s", (_label, input) => {
    expect(swipeAtSchema.safeParse(input).success).toBe(true);
  });

  test.each([
    ["missing to", { platform: "android", from: { x: 1, y: 2 } }, ["to"]],
    ["missing from", { platform: "android", to: { x: 1, y: 2 } }, ["from"]],
    ["neither point nor image", { platform: "android" }, ["from"]],
    [
      "image together with from",
      {
        platform: "android",
        from: { x: 1, y: 2 },
        image: {
          unit: "normalized",
          source: imageSource,
          from: { x: 0.1, y: 0.1 },
          to: { x: 0.9, y: 0.6 },
        },
      },
      ["image"],
    ],
    [
      "image together with coordinateSpace",
      {
        platform: "android",
        coordinateSpace: "percent",
        image: {
          unit: "normalized",
          source: imageSource,
          from: { x: 0.1, y: 0.1 },
          to: { x: 0.9, y: 0.6 },
        },
      },
      ["image"],
    ],
    [
      "normalized from.x above 1",
      {
        platform: "android",
        from: { x: 1.5, y: 0 },
        to: { x: 0.5, y: 0.5 },
        coordinateSpace: "normalized",
      },
      ["from", "x"],
    ],
    [
      "percent to.y above 100",
      {
        platform: "android",
        from: { x: 5, y: 5 },
        to: { x: 5, y: 101 },
        coordinateSpace: "percent",
      },
      ["to", "y"],
    ],
    [
      "negative normalized to.x",
      {
        platform: "android",
        from: { x: 0.2, y: 0.2 },
        to: { x: -0.1, y: 0.5 },
        coordinateSpace: "normalized",
      },
      ["to", "x"],
    ],
    [
      "unknown speed",
      { platform: "android", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, speed: "warp" },
      ["speed"],
    ],
    [
      "non-finite coordinate",
      { platform: "android", from: { x: Number.NaN, y: 2 }, to: { x: 3, y: 4 } },
      ["from", "x"],
    ],
    [
      "undeclared durationMs",
      { platform: "android", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 500 },
      [],
    ],
    [
      "extra key on a point",
      { platform: "android", from: { x: 1, y: 2, z: 3 }, to: { x: 3, y: 4 } },
      [],
    ],
  ])("rejects %s", (_label, input, path) => {
    const result = swipeAtSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success && path.length > 0) {
      expect(
        result.error.issues.some((issue) => issue.path.join(".").startsWith(path.join("."))),
      ).toBe(true);
    }
  });
});

describe("swipeAtHandler", () => {
  const success: SwipeResult = { success: true, x1: 10, y1: 20, x2: 80, y2: 170, duration: 300 };

  test("forwards coordinates, speed, layer and snapshot to the action", async () => {
    const received: SwipeAtOptions[] = [];
    const swipeAtHandler = handlerFor(async (options) => {
      received.push(options);
      return success;
    });

    const response = await swipeAtHandler(device, {
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.9, y: 0.8 },
      coordinateSpace: "normalized",
      speed: "slow",
      layer: "app",
      snapshotId: "snapshot-9",
      display: "cover",
    });

    expect(received).toEqual([
      {
        from: { x: 0.1, y: 0.1 },
        to: { x: 0.9, y: 0.8 },
        coordinateSpace: "normalized",
        speed: "slow",
        layer: "app",
        snapshotId: "snapshot-9",
        display: "cover",
      },
    ]);
    expect(response.isError).toBeUndefined();
    expect(getStructuredField(response, "message")).toBe("Swiped from (10, 20) to (80, 170)");
    expect(getStructuredField(response, "deviceId")).toBe(device.deviceId);
    expect(getStructuredField(response, "platform")).toBe("android");
  });

  test("passes an image swipe through without outer coordinates", async () => {
    const received: SwipeAtOptions[] = [];
    const swipeAtHandler = handlerFor(async (options) => {
      received.push(options);
      return success;
    });
    const image = {
      unit: "normalized" as const,
      source: imageSource,
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.9, y: 0.6 },
    };

    await swipeAtHandler(device, { image });

    expect(received).toHaveLength(1);
    expect(received[0].image).toEqual(image);
    expect(received[0].from).toBeUndefined();
    expect(received[0].to).toBeUndefined();
  });

  test("marks a failed swipe as an error with the reason", async () => {
    const swipeAtHandler = handlerFor(async () => ({
      success: false,
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
      duration: 0,
      error: "swipeAt coordinates (3, 4) are outside screen bounds",
    }));

    const response = await swipeAtHandler(device, { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });

    expect(response.isError).toBe(true);
    expect(getStructuredField(response, "message")).toBe(
      "Failed to swipe from (1, 2) to (3, 4): swipeAt coordinates (3, 4) are outside screen bounds",
    );
    expect(getStructuredField(response, "error")).toContain("outside screen bounds");
  });
});
