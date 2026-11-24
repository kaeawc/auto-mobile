import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import ornamentHierarchy from "../../fixtures/visionos-xcuitest/hierarchy-ornament-window.json";
import { PressButton } from "../../../src/features/action/PressButton";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import {
  VISIONOS_SWIPE_DURATION_RANGE_MS,
  visionosPress,
  visionosSwipeOn,
  visionosSwipeStroke,
  visionosTapAt,
} from "../../../src/features/visionos/VisionosGestures";
import { isVisionosHierarchy } from "../../../src/features/visionos/VisionosHierarchy";
import { visionosRunners } from "../../../src/features/visionos/VisionosRunnerRegistry";
import type { SwipeOnOptions, TapAtOptions } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import { defaultTapAtElementFactory } from "../../../src/server/interactionTools/tapHandlers";
import { withVisionosHomeScreen } from "../../../src/server/visionosHomeScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeVisionosRunnerClient } from "../../fakes/FakeVisionosRunnerClient";
import { toolIsError, toolStructured } from "../../helpers/toolResponse";

const device = { platform: "visionos", deviceId: "vision-gestures", name: "Vision Pro" } as const;
let client: FakeVisionosRunnerClient;
let unregister: () => void;

function useClient(next: FakeVisionosRunnerClient) {
  unregister?.();
  client = next;
  unregister = visionosRunners.register(device.deviceId, client);
}

/** The connected runner answers each command with an error, as a failed XCTest gesture does. */
function failRequests() {
  client.request = async (command) => {
    client.commands.push(command);
    throw new Error("runner gone");
  };
}

beforeEach(() => useClient(new FakeVisionosRunnerClient()));
afterEach(() => unregister());

describe("tapAt", () => {
  test("sends a window point to the runner's coordinate tap", async () => {
    const result = await visionosTapAt(device.deviceId, { x: 640.5, y: 232 });
    expect(result).toEqual({
      success: true,
      x: 640.5,
      y: 232,
      action: "tap",
      dispatchRoute: "xcuiCoordinate",
    });
    expect(client.commands).toEqual([{ type: "request_tap_coordinates", x: 640.5, y: 232 }]);
  });

  test("the tapAt tool's factory routes a Vision Pro to the runner", async () => {
    const result = await defaultTapAtElementFactory(device).execute({
      x: 10,
      y: 20,
      coordinateSpace: "absolute",
    });
    expect(result).toMatchObject({ success: true, x: 10, y: 20 });
    expect(client.commands).toEqual([{ type: "request_tap_coordinates", x: 10, y: 20 }]);
  });

  test.each<[string, TapAtOptions, string]>([
    ["long press", { x: 1, y: 1, action: "longPress" }, "only action tap"],
    ["double tap", { x: 1, y: 1, action: "doubleTap" }, "only action tap"],
    ["normalized", { x: 0.5, y: 0.5, coordinateSpace: "normalized" }, "coordinateSpace normalized"],
    ["percent", { x: 50, y: 50, coordinateSpace: "percent" }, "coordinateSpace percent"],
    ["snapshotId", { x: 1, y: 1, snapshotId: "snap" }, "snapshotId"],
    ["display", { x: 1, y: 1, display: "0" }, "display"],
    ["negative x", { x: -1, y: 1 }, "finite non-negative"],
    ["infinite y", { x: 1, y: Number.POSITIVE_INFINITY }, "finite non-negative"],
  ])("refuses %s before any command", async (_name, options, message) => {
    const tap = visionosTapAt(device.deviceId, options);
    await expect(tap).rejects.toBeInstanceOf(ActionableError);
    await expect(tap).rejects.toThrow(message);
    expect(client.commands).toEqual([]);
  });

  test("an aborted call sends nothing", async () => {
    const signal = AbortSignal.abort(new Error("tap cancelled"));
    await expect(visionosTapAt(device.deviceId, { x: 1, y: 1 }, signal)).rejects.toThrow(
      "tap cancelled",
    );
    expect(client.commands).toEqual([]);
  });

  test("a runner failure propagates", async () => {
    failRequests();
    await expect(visionosTapAt(device.deviceId, { x: 1, y: 1 })).rejects.toThrow("runner gone");
  });
});

describe("swipeOn", () => {
  const window = { left: 0, top: 0, right: 1280, bottom: 720 };

  test.each<[SwipeOnOptions["direction"], Record<string, number>]>([
    ["up", { x1: 640, y1: 540, x2: 640, y2: 180 }],
    ["down", { x1: 640, y1: 180, x2: 640, y2: 540 }],
    ["left", { x1: 960, y1: 360, x2: 320, y2: 360 }],
    ["right", { x1: 320, y1: 360, x2: 960, y2: 360 }],
  ])("a %s stroke crosses the middle half of the target", (direction, stroke) => {
    expect(visionosSwipeStroke(window, direction)).toEqual(stroke as never);
  });

  test("swipes the app window by default at the normal speed", async () => {
    const result = await visionosSwipeOn(device.deviceId, { direction: "up", autoTarget: true });
    expect(result).toEqual({
      success: true,
      targetType: "screen",
      x1: 640,
      y1: 540,
      x2: 640,
      y2: 180,
      duration: 300,
    });
    expect(client.commands).toEqual([
      { type: "request_hierarchy" },
      { type: "request_swipe", x1: 640, y1: 540, x2: 640, y2: 180, duration: 300 },
    ]);
  });

  test("scrollTowardsDirection moves the finger the opposite way", async () => {
    await visionosSwipeOn(device.deviceId, {
      direction: "up",
      gestureType: "scrollTowardsDirection",
    });
    expect(client.commands[1]).toMatchObject({ y1: 180, y2: 540 });
  });

  test("speed and durationMs set the stroke duration", async () => {
    await visionosSwipeOn(device.deviceId, { direction: "left", speed: "slow" });
    await visionosSwipeOn(device.deviceId, { direction: "left", durationMs: 1234.4 });
    expect(
      client.commands
        .filter((command) => command.type === "request_swipe")
        .map((command) => (command as { duration: number }).duration),
    ).toEqual([600, 1234]);
  });

  test("a container swipes across that element's bounds", async () => {
    const result = await visionosSwipeOn(device.deviceId, {
      direction: "right",
      container: { elementId: "field" },
    });
    // field spans x 440-840, y 410.5-454.5 in the probe capture.
    expect(result).toMatchObject({
      success: true,
      targetType: "element",
      element: { "resource-id": "field" },
      x1: 540,
      y1: 432.5,
      x2: 740,
      y2: 432.5,
    });
  });

  test("a container in an ornament is refused, since its bounds are scene-local", async () => {
    const tree = structuredClone(ornamentHierarchy.data);
    if (!isVisionosHierarchy(tree)) {
      throw new Error("Expected a valid ornament hierarchy fixture");
    }
    useClient(new FakeVisionosRunnerClient(tree));
    await expect(
      visionosSwipeOn(device.deviceId, { direction: "up", container: { text: "Add item" } }),
    ).rejects.toThrow("ornament");
    expect(client.commands).toEqual([{ type: "request_hierarchy" }]);
  });

  test("an unmatched container sends no swipe", async () => {
    await expect(
      visionosSwipeOn(device.deviceId, { direction: "up", container: { elementId: "missing" } }),
    ).rejects.toThrow("No visionOS element matched the swipe container");
    expect(client.commands).toEqual([{ type: "request_hierarchy" }]);
  });

  test.each<[string, SwipeOnOptions, string]>([
    ["lookFor", { direction: "up", lookFor: { text: "B22" } }, "lookFor"],
    ["fromEdge", { direction: "up", fromEdge: "bottom" }, "fromEdge"],
    ["boomerang", { direction: "up", boomerang: true }, "boomerang"],
    ["display", { direction: "up", display: "0" }, "display"],
    [
      "a nested container",
      { direction: "up", container: { elementId: "a", container: { elementId: "b" } } },
      "container.container",
    ],
    ["an empty container", { direction: "up", container: {} }, "elementId or text"],
    [
      "a negative container index",
      { direction: "up", container: { text: "B01", index: -1 } },
      "non-negative",
    ],
    [
      "a too-short duration",
      { direction: "up", durationMs: VISIONOS_SWIPE_DURATION_RANGE_MS.min - 1 },
      "durationMs must be from 50 to 10000",
    ],
    [
      "a too-long duration",
      { direction: "up", durationMs: VISIONOS_SWIPE_DURATION_RANGE_MS.max + 1 },
      "durationMs must be from 50 to 10000",
    ],
  ])("refuses %s before any command", async (_name, options, message) => {
    const swipe = visionosSwipeOn(device.deviceId, options);
    await expect(swipe).rejects.toBeInstanceOf(ActionableError);
    await expect(swipe).rejects.toThrow(message);
    expect(client.commands).toEqual([]);
  });

  test("the SwipeOn action routes a Vision Pro to the runner", async () => {
    const timer = new FakeTimer();
    const result = await new SwipeOn(device, null, { timer }).execute({
      direction: "down",
      autoTarget: true,
      includeSystemInsets: false,
    });
    expect(result).toMatchObject({ success: true, targetType: "screen", y1: 180, y2: 540 });
    expect(client.commands.map((command) => command.type)).toEqual([
      "request_hierarchy",
      "request_swipe",
    ]);
    expect(timer.getSleepHistory()).toEqual([]);
  });
});

describe("home press", () => {
  test("pressButton home sends the runner's home press", async () => {
    const result = await new PressButton(device, null, new FakeTimer()).execute("home");
    expect(result).toMatchObject({ success: true, button: "home" });
    expect(client.commands).toEqual([{ type: "request_press_home" }]);
  });

  test.each(["back", "power", "volume_up", "menu"])(
    "pressButton %s is refused before any command",
    async (button) => {
      await expect(visionosPress(device.deviceId, button)).rejects.toThrow(
        `supports only home (the Digital Crown press), not ${button}`,
      );
      expect(client.commands).toEqual([]);
    },
  );

  test("pressButton home refuses steps and holds", async () => {
    const press = new PressButton(device, null, new FakeTimer());
    await expect(press.execute("home", { steps: 2 })).rejects.toThrow("does not take steps");
    await expect(press.execute("home", { durationMs: 800 })).rejects.toThrow("durationMs");
    expect(client.commands).toEqual([]);
  });

  describe("homeScreen", () => {
    const mobileCalls: string[] = [];
    const handler = withVisionosHomeScreen(async (target: typeof device | { platform: string }) => {
      mobileCalls.push(target.platform);
      return { content: [] };
    });
    beforeEach(() => {
      mobileCalls.length = 0;
    });

    test("presses the Digital Crown through the runner", async () => {
      const response = await handler(device, {});
      expect(client.commands).toEqual([{ type: "request_press_home" }]);
      expect(mobileCalls).toEqual([]);
      expect(toolStructured(response)).toMatchObject({
        message: "Pressed the Digital Crown (home)",
        success: true,
        navigationMethod: "hardware",
      });
      expect(toolIsError(response)).toBe(false);
    });

    test("a runner failure surfaces as an actionable error", async () => {
      failRequests();
      const press = handler(device, {});
      await expect(press).rejects.toBeInstanceOf(ActionableError);
      await expect(press).rejects.toThrow("Failed to go to home screen");
    });

    test("other platforms keep the mobile handler", async () => {
      await handler({ platform: "ios", name: "iPhone", deviceId: "IPHONE" }, {});
      expect(mobileCalls).toEqual(["ios"]);
      expect(client.commands).toEqual([]);
    });
  });
});
