import { InputText } from "../../../src/features/action/InputText";
import { SwipeAtCoordinate } from "../../../src/features/action/SwipeAtCoordinate";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { watchRunners } from "../../../src/features/watch/WatchRunnerRegistry";
import {
  watchTapOn,
  watchTapAt,
  watchSwipeOn,
  watchPress,
} from "../../../src/features/watch/WatchActions";
import { FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { defaultTapAtElementFactory } from "../../../src/server/interactionTools/tapHandlers";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { PressButton } from "../../../src/features/action/PressButton";
import { SendKeys } from "../../../src/features/action/SendKeys";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { MultiTouchGesture } from "../../../src/features/action/MultiTouchGesture";
import type { BootedDevice } from "../../../src/models";

const device: BootedDevice = { deviceId: "watch-actions", platform: "watchos", name: "Watch" };
let client: FakeWatchRunnerClient;
let unregister: () => void;
beforeEach(() => {
  client = new FakeWatchRunnerClient();
  unregister = watchRunners.register(device.deviceId, client);
});
afterEach(() => unregister());

describe("watch actions", () => {
  test("taps by identifier through the tapOn entry point", async () => {
    const result = await new TapOnElement(device, null, { timer: new FakeTimer() }).execute({
      action: "tap",
      elementId: "tapme",
    });
    expect(result.success).toBe(true);
    expect(client.commands).toEqual([{ type: "hierarchy" }, { type: "tap", identifier: "tapme" }]);
  });
  test("text-only nodes dispatch their center in XCTest points", async () => {
    await watchTapOn(device.deviceId, { action: "tap", text: "row 0" });
    expect(client.commands[1]).toEqual({ type: "tap", x: 104, y: 179.05 });
  });
  test("coordinate entry point routes without a hierarchy read", async () => {
    const result = await defaultTapAtElementFactory(device).execute({
      x: 50,
      y: 80,
    });
    expect(result).toMatchObject({ success: true, x: 50, y: 80 });
    expect(client.commands).toEqual([{ type: "tap", x: 50, y: 80 }]);
  });
  test.each(["call context", "positional"] as const)(
    "coordinate entry point honors cancellation via %s before any command",
    async (form) => {
      const signal = AbortSignal.abort(new Error("watch tap cancelled"));
      const tap = defaultTapAtElementFactory(device);
      await expect(
        form === "call context"
          ? tap.execute({ x: 50, y: 80 }, { signal })
          : tap.execute({ x: 50, y: 80 }, undefined, signal),
      ).rejects.toThrow("watch tap cancelled");
      expect(client.commands).toEqual([]);
    },
  );
  test("refuses offscreen text matches", async () => {
    await expect(watchTapOn(device.deviceId, { action: "tap", text: "row 7" })).rejects.toThrow(
      "No watch element matched",
    );
    expect(client.commands).toEqual([{ type: "hierarchy" }]);
  });
  test("swipeOn entry point sends direction and home entry point sends home", async () => {
    const timer = new FakeTimer();
    const swipe = await new SwipeOn(device, null, { timer }).execute({ direction: "up" });
    expect(swipe).toMatchObject({ success: true, durationIgnored: true });
    await new PressButton(device, null, timer).execute("home");
    expect(client.commands).toEqual([{ type: "swipe", direction: "up" }, { type: "home" }]);
    expect(timer.getSleepHistory()).toEqual([]);
  });
  test("lookFor matches identifiers and text with a bounded direction search", async () => {
    expect(
      await watchSwipeOn(device.deviceId, { direction: "up", lookFor: { elementId: "tapme" } }),
    ).toMatchObject({ found: true, scrollIterations: 0 });
    client.commands.length = 0;
    expect(
      await watchSwipeOn(device.deviceId, {
        direction: "up",
        gestureType: "scrollTowardsDirection",
        lookFor: { text: "row 7", maxSwipes: 2 },
      }),
    ).toMatchObject({ found: false, scrollIterations: 2 });
    expect(client.commands.filter((command) => command.type === "swipe")).toEqual([
      { type: "swipe", direction: "down" },
      { type: "swipe", direction: "down" },
    ]);
  });
  test("long press, pinch, multi-touch and text reject before any command", async () => {
    const timer = new FakeTimer();
    await expect(
      new TapOnElement(device, null, { timer }).execute({ action: "longPress", text: "Tap me" }),
    ).rejects.toThrow("longPress");
    await expect(
      defaultTapAtElementFactory(device).execute({ x: 1, y: 2, action: "longPress" }),
    ).rejects.toThrow("longPress");
    await expect(new PinchOn(device, null, { timer }).execute({ direction: "in" })).rejects.toThrow(
      "pinch",
    );
    expect(() => new SendKeys(device, undefined, { timer })).toThrow("text input");
    await expect(
      new MultiTouchGesture(device, null, { timer }).execute({
        action: "swipe",
        x: 10,
        y: 20,
        direction: "up",
        fingers: 2,
      }),
    ).rejects.toThrow("multi-touch");
    await expect(new InputText(device, null, { timer }).execute("hello")).rejects.toThrow(
      "text input",
    );
    await expect(
      new SwipeAtCoordinate(device, null, { timer }).execute({
        from: { x: 1, y: 2 },
        to: { x: 3, y: 4 },
      }),
    ).rejects.toThrow("coordinate swipe");
    expect(client.commands).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });
  test("refuses unsupported targeting and non-absolute coordinates before commands", async () => {
    await expect(
      watchTapOn(device.deviceId, { action: "doubleTap", text: "Tap me" }),
    ).rejects.toThrow("doubleTap");
    await expect(
      watchTapAt(device.deviceId, { x: 1, y: 1, coordinateSpace: "normalized" }),
    ).rejects.toThrow("non-absolute");
    await expect(
      watchSwipeOn(device.deviceId, { direction: "up", container: { text: "list" } }),
    ).rejects.toThrow("container");
    await expect(watchPress(device.deviceId, "back")).rejects.toThrow("press back");
    expect(client.commands).toEqual([]);
  });
});
