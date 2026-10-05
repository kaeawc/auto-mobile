import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ExecuteGesture } from "../../../../src/features/action/ExecuteGesture";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { executeAndroidSearchDrag } from "../../../../src/features/action/swipeon/androidSearchDrag";
import { StaleDisplayError } from "../../../../src/models/StaleDisplayError";
import { ScrollUntilVisible } from "../../../../src/features/action/swipeon/ScrollUntilVisible";
import { TalkBackSwipeExecutor } from "../../../../src/features/action/swipeon/TalkBackSwipeExecutor";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeScrollAccessibilityService } from "../../../fakes/FakeScrollAccessibilityService";
import { FakeOverlayDetector } from "../../../fakes/FakeOverlayDetector";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { logger } from "../../../../src/utils/logger";
import type { ObserveResult } from "../../../../src/models";

const device = { name: "fake", deviceId: "fake-gesture", platform: "android" } as const;
afterEach(() => {
  mock.restore();
  AndroidCtrlProxyClient.resetInstances();
});

function searchHarness(foundAfter = 1, residualMomentum = false) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbExecutor();
  const geometry = new DefaultElementGeometry();
  const gesture = new ExecuteGesture(device, adb, timer);
  const detector = new FakeAccessibilityDetector();
  const client = AndroidCtrlProxyClient.getInstance(device);
  let scrolls = 0;
  const observe = (): ObserveResult => ({
    timestamp: timer.now(),
    screenSize: { width: 1080, height: 2400 },
    viewHierarchy: {
      hierarchy: {
        node: {
          "resource-id": "list",
          scrollable: true,
          bounds: { left: 0, top: 300, right: 1080, bottom: 2100 },
          node: [
            ...Array.from({ length: 4 }, (_, i) => ({
              text: `${residualMomentum && scrolls === 1 ? "gap" : "shared"} ${i}`,
              bounds: { left: 0, top: 900 + i * 150, right: 1080, bottom: 1050 + i * 150 },
            })),
            {
              text: residualMomentum && scrolls === 1 ? "gap" : "overlap",
              bounds: { left: 0, top: 300, right: 1080, bottom: 600 },
            },
            {
              text: scrolls >= foundAfter ? "Target" : `page ${scrolls}`,
              bounds: { left: 0, top: 600, right: 1080, bottom: 900 },
            },
          ],
        },
      },
    },
  });
  const screen = new FakeObserveScreen();
  screen.setObserveResult(observe);
  const scroll = new ScrollUntilVisible({
    device,
    geometry,
    timer,
    adb,
    observeScreen: screen,
    accessibilityDetector: detector,
    accessibilityService: new FakeScrollAccessibilityService(),
    overlayDetector: new FakeOverlayDetector(),
    talkBackExecutor: new TalkBackSwipeExecutor(device, gesture, client, detector, adb, timer),
    getDuration: (options) => options.duration ?? geometry.getSwipeDurationFromSpeed(options.speed),
    resolveBoomerangConfig: () => undefined,
    buildPredictionArgs: () => ({}),
    observedInteraction: async (action) => {
      const result = await action(observe());
      scrolls++;
      timer.advanceTime(600);
      return { ...result, observation: observe() };
    },
  });
  return {
    adb,
    gesture,
    search: (scrollMode?: "adb") => {
      scrolls = 0;
      screen.setObserveResult(observe);
      return scroll.execute({ direction: "up", lookFor: { text: "Target" }, scrollMode });
    },
  };
}

for (const unavailable of [
  "API 24",
  "metadata failure",
  "not connected",
  "unsupported command",
  "metadata throws",
] as const) {
  test(`correction: ${unavailable} lookFor falls back to one capped slow ADB swipe and finds target`, async () => {
    const info = spyOn(AndroidCtrlProxyClient.prototype, "requestDeviceInfo");
    if (unavailable === "API 24") {
      info.mockResolvedValue({ success: true, sdkInt: 24, totalTimeMs: 0 });
    } else if (unavailable === "metadata throws") {
      info.mockRejectedValue(new Error("metadata unavailable"));
    } else {
      info.mockResolvedValue({ success: false, error: unavailable, totalTimeMs: 0 });
    }
    const drag = spyOn(AndroidCtrlProxyClient.prototype, "requestDrag");
    const h = searchHarness();
    expect(await h.search()).toMatchObject({ success: true, found: true, scrollIterations: 1 });
    expect(h.adb.getExecutedCommands()).toEqual(["shell input swipe 540 1920 540 570 600"]);
    expect(drag).not.toHaveBeenCalled();
  });
}

test("correction: unsupported drag before dispatch falls back exactly once", async () => {
  spyOn(AndroidCtrlProxyClient.prototype, "requestDeviceInfo").mockResolvedValue({
    success: true,
    sdkInt: 36,
    totalTimeMs: 0,
  });
  const drag = spyOn(AndroidCtrlProxyClient.prototype, "requestDrag").mockResolvedValue({
    success: false,
    error: "unsupported command: drag",
    totalTimeMs: 0,
  });
  const h = searchHarness();
  expect(await h.search()).toMatchObject({ success: true, found: true, scrollIterations: 1 });
  expect(drag).toHaveBeenCalledTimes(1);
  expect(h.adb.getExecutedCommands()).toEqual(["shell input swipe 540 1920 540 570 600"]);
});

test("correction: residual momentum on ADB fallback uses the shared half-viewport recovery", async () => {
  spyOn(AndroidCtrlProxyClient.prototype, "requestDeviceInfo").mockResolvedValue({
    success: true,
    sdkInt: 24,
    totalTimeMs: 0,
  });
  const h = searchHarness(2, true);
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 1 });
  expect(h.adb.getExecutedCommands()).toEqual([
    "shell input swipe 540 1920 540 570 600",
    "shell input swipe 540 750 540 1650 600",
  ]);
});

for (const throws of [false, true]) {
  test(`correction: dispatched drag timeout stops search without ADB fallback (throws=${throws})`, async () => {
    spyOn(AndroidCtrlProxyClient.prototype, "requestDeviceInfo").mockResolvedValue({
      success: true,
      sdkInt: 36,
      totalTimeMs: 0,
    });
    const drag = spyOn(AndroidCtrlProxyClient.prototype, "requestDrag").mockImplementation(
      async (...args) => {
        args[12]?.();
        if (throws) {
          throw new Error("timed out");
        }
        return { success: false, error: "timed out", totalTimeMs: 0 };
      },
    );
    const h = searchHarness();
    await expect(h.search()).rejects.toThrow("indeterminate");
    expect(drag).toHaveBeenCalledTimes(1);
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });
}

test("correction: fallback debug log is emitted once per search across multiple steps", async () => {
  spyOn(AndroidCtrlProxyClient.prototype, "requestDeviceInfo").mockResolvedValue({
    success: false,
    error: "not connected",
    totalTimeMs: 0,
  });
  const debug = spyOn(logger, "debug");
  const h = searchHarness(3);
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 3 });
  expect(h.adb.getExecutedCommands()).toHaveLength(3);
  expect(
    debug.mock.calls.filter(([message]) => message.includes("slow ADB swipe fallback")),
  ).toHaveLength(1);
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 3 });
  expect(
    debug.mock.calls.filter(([message]) => message.includes("slow ADB swipe fallback")),
  ).toHaveLength(2);
});

test("Android search uses the existing continuous drag, zero press and 100ms endpoint hold", async () => {
  spyOn(AndroidCtrlProxyClient.prototype, "requestDeviceInfo").mockResolvedValue({
    success: true,
    sdkInt: 36,
    totalTimeMs: 0,
  });
  const drag = spyOn(AndroidCtrlProxyClient.prototype, "requestDrag").mockResolvedValue({
    success: true,
    totalTimeMs: 700,
  });
  const adb = new FakeAdbExecutor();
  const gesture = new ExecuteGesture(device, adb, new FakeTimer());
  expect(
    await gesture.swipe(540, 2114, 540, 590, { duration: 600, searchScroll: true }),
  ).toMatchObject({ success: true });
  expect(drag.mock.calls[0]?.slice(0, 8)).toEqual([540, 2114, 540, 590, 0, 600, 100, 5000]);
  expect(adb.getExecutedCommands()).toEqual([]);
});

test("ordinary Android swipe keeps its exact coordinates, duration and ADB route", async () => {
  const drag = spyOn(AndroidCtrlProxyClient.prototype, "requestDrag");
  const adb = new FakeAdbExecutor();
  const gesture = new ExecuteGesture(device, adb, new FakeTimer());
  expect(await gesture.swipe(540, 2114, 540, 505)).toMatchObject({
    success: true,
    x1: 540,
    y1: 2114,
    x2: 540,
    y2: 505,
    duration: 300,
  });
  expect(adb.getExecutedCommands()).toEqual(["shell input swipe 540 2114 540 505 300"]);
  expect(drag).not.toHaveBeenCalled();
});

test("correction: issue geometry fallback travels 1509px over the slow 600ms preset", async () => {
  spyOn(AndroidCtrlProxyClient.prototype, "requestDeviceInfo").mockResolvedValue({
    success: true,
    sdkInt: 24,
    totalTimeMs: 0,
  });
  const adb = new FakeAdbExecutor();
  const gesture = new ExecuteGesture(device, adb, new FakeTimer());
  expect(
    await gesture.swipe(540, 2114, 540, 505, {
      searchScroll: true,
      duration: 1,
      searchScrollBounds: { left: 0, top: 304, right: 1080, bottom: 2316 },
    }),
  ).toMatchObject({ success: true, y1: 2114, y2: 605, duration: 600 });
  expect(adb.getExecutedCommands()).toEqual(["shell input swipe 540 2114 540 605 600"]);
  expect((2114 - 605) / (600 / 1000)).toBe(2515);
});

test("dispatched drag rejection reports an indeterminate outcome for the loop", async () => {
  const result = await executeAndroidSearchDrag({
    client: {
      requestDeviceInfo: async () => ({ success: true, sdkInt: 36, totalTimeMs: 0 }),
      requestDrag: async (...args) => {
        args[12]?.();
        return { success: false, error: "ack lost", totalTimeMs: 0 };
      },
    },
    x1: 0,
    y1: 600,
    x2: 0,
    y2: 0,
    duration: 600,
    fallback: async () => {
      throw new Error("must not fall back after dispatch");
    },
  });
  expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
  expect(result.error).toContain("ack lost");
  expect(result.error).toContain("gesture was dispatched");
  expect(result.error).toContain("Do not retry automatically");
});

test("a drag that loses its display after dispatch carries typed guidance and delivery", async () => {
  const details = { observedGeneration: 1, currentGeneration: 2, retry: "observe" as const };
  const result = await executeAndroidSearchDrag({
    client: {
      requestDeviceInfo: async () => ({ success: true, sdkInt: 36, totalTimeMs: 0 }),
      requestDrag: async (...args) => {
        args[12]?.();
        throw new StaleDisplayError(details);
      },
    },
    x1: 0,
    y1: 600,
    x2: 0,
    y2: 0,
    duration: 600,
    fallback: async () => {
      throw new Error("must not fall back after dispatch");
    },
  });
  expect(result).toMatchObject({
    success: false,
    outcomeIndeterminate: true,
    staleDisplay: details,
  });
  expect(result.error).toContain("gesture was dispatched");
  expect(result.error).toContain("Do not retry automatically");
});

test("review: device-info probe is cached for one multi-step default-display search", async () => {
  const info = spyOn(AndroidCtrlProxyClient.prototype, "requestDeviceInfo").mockResolvedValue({
    success: true,
    sdkInt: 36,
    totalTimeMs: 0,
  });
  spyOn(AndroidCtrlProxyClient.prototype, "requestDrag").mockResolvedValue({
    success: true,
    totalTimeMs: 0,
  });
  const h = searchHarness(3);
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 3 });
  expect(info).toHaveBeenCalledTimes(1);
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 3 });
  expect(info).toHaveBeenCalledTimes(2);
});

test("review: explicit adb lookFor on default display uses slow adb without CtrlProxy drag", async () => {
  spyOn(AndroidCtrlProxyClient.prototype, "requestDeviceInfo").mockResolvedValue({
    success: true,
    sdkInt: 36,
    totalTimeMs: 0,
  });
  const drag = spyOn(AndroidCtrlProxyClient.prototype, "requestDrag").mockResolvedValue({
    success: true,
    totalTimeMs: 0,
  });
  const h = searchHarness();
  expect(await h.search("adb")).toMatchObject({ found: true });
  expect(h.adb.getExecutedCommands()).toEqual(["shell input swipe 540 1920 540 570 600"]);
  expect(drag).not.toHaveBeenCalled();
});
