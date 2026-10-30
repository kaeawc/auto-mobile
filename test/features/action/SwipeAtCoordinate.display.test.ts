import { buildObserveResult } from "../../helpers/observeFixture";
import { createExecResult } from "../../../src/utils/execResult";
import { afterEach, describe, expect, test } from "bun:test";
import { SwipeAtCoordinate } from "../../../src/features/action/SwipeAtCoordinate";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { BootedDevice } from "../../../src/models";
import { runWithSelectedDisplayPin } from "../../../src/features/observe/SessionDisplayContext";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { observation } from "../../helpers/tapAtCoordinate";

const device: BootedDevice = {
  deviceId: "swipe-at-display",
  platform: "android",
  name: "Fake foldable",
  displays: {
    panels: [
      { key: "internal", role: "inner", sizePx: { width: 100, height: 200 } },
      { key: "external", role: "external", sizePx: { width: 400, height: 800 } },
    ],
    postures: [],
  },
};
const iosDevice: BootedDevice = { deviceId: "swipe-at-display-ios", platform: "ios", name: "iOS" };

function setup(
  options: {
    capable?: boolean;
    panel?: string;
    target?: BootedDevice;
    width?: number;
    height?: number;
  } = {},
) {
  const {
    capable = true,
    panel = "external",
    target = device,
    width = 400,
    height = 800,
  } = options;
  const gestureSwipes: Array<[number, number, number, number, boolean]> = [];
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse(
    "cmd display get-displays",
    createExecResult(
      'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 200}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 400 x 800}',
      "",
    ),
  );
  const ctrl = new FakeCtrlProxy();
  ctrl.setSupportedCommands(capable ? ["gesture_display_id_v1"] : []);
  const observe = new FakeObserveScreen();
  observe.setObserveResult(
    buildObserveResult({
      ...observation(width, height),
      display: { key: panel, role: "external", posture: "unknown", generation: 7 },
    }),
  );
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const transitions = new FakeDisplayTransitionReader();
  const renderedRevision = transitions.fullRevision;
  const swipeAt = new SwipeAtCoordinate(target, adb, {
    timer,
    androidClient: ctrl,
    executeGesture: {
      swipe: async ({ x1, y1, x2, y2 }, opts) => {
        opts?.displayFence?.assertCurrent();
        gestureSwipes.push([x1, y1, x2, y2, opts?.displayFence !== undefined]);
        return { success: true, x1, y1, x2, y2, duration: opts?.duration ?? 0 };
      },
    },
    displayTransitions: transitions,
    lastRenderedObservation: () => ({
      display: { key: panel, generation: 7 },
      displayRevision: renderedRevision,
    }),
  });
  swipeAt.window = new FakeWindow();
  swipeAt.observeScreen = observe;
  return { swipeAt, ctrl, adb, transitions, observe, gestureSwipes };
}

afterEach(() => displayTransitions.reset(device.deviceId));

describe("swipeAt display", () => {
  test("swipes on the selected panel through CtrlProxy with its display id", async () => {
    const { swipeAt, ctrl } = setup();

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 0.25, y: 0.5 },
      to: { x: 0.75, y: 0.5 },
      coordinateSpace: "normalized",
    });

    expect(result).toMatchObject({ success: true, x1: 100, y1: 400, x2: 300, y2: 400 });
    expect(ctrl.getSwipeHistory()).toMatchObject([
      { x1: 100, y1: 400, x2: 300, y2: 400, displayId: 2 },
    ]);
  });

  test("the default display uses the same injection as the no-display path", async () => {
    const { swipeAt, ctrl, gestureSwipes } = setup({ panel: "internal", width: 100, height: 200 });

    const result = await swipeAt.execute({
      display: "internal",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result.success).toBe(true);
    expect(gestureSwipes).toEqual([[10, 20, 10, 150, true]]);
    expect(ctrl.getSwipeHistory()).toEqual([]);
  });

  test("a CtrlProxy without gesture_display_id_v1 falls back to adb touchscreen routing", async () => {
    const { swipeAt, ctrl, adb } = setup({ capable: false });

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result.success).toBe(true);
    expect(ctrl.getSwipeHistory()).toEqual([]);
    expect(adb.getExecutedCommands().join("\n")).toContain(
      "input touchscreen -d 2 swipe 10 20 10 150 300",
    );
  });

  test("durationMs sets the panel swipe duration and reports its velocity", async () => {
    const { swipeAt, adb } = setup({ capable: false });

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
      durationMs: 65,
    });

    expect(result.success).toBe(true);
    expect(result.duration).toBe(65);
    // 130 px over 65 ms.
    expect(result.velocityPxPerSecond).toBe(2000);
    expect(adb.getExecutedCommands().join("\n")).toContain(
      "input touchscreen -d 2 swipe 10 20 10 150 65",
    );
  });

  test("a CtrlProxy failure before dispatch falls back to adb", async () => {
    const { swipeAt, ctrl, adb } = setup();
    ctrl.setSwipeResult({ success: false, error: "gesture rejected", totalTimeMs: 0 });

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands().join("\n")).toContain("input touchscreen -d 2 swipe");
  });

  test("a swipe dispatched but reported failed is indeterminate and not retried", async () => {
    const { swipeAt, ctrl, adb } = setup();
    ctrl.setSwipeDispatchesBeforeResult(true);
    ctrl.setSwipeResult({ success: false, error: "no ack", totalTimeMs: 0 });

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result).toMatchObject({
      success: false,
      outcomeIndeterminate: true,
      duration: 300,
    });
    expect(result.error).toContain("do not retry automatically");
    expect(adb.getExecutedCommands().join("\n")).not.toContain("touchscreen");
  });

  test("a non-stale rejection after dispatch becomes a structured failure", async () => {
    const { swipeAt, ctrl } = setup();
    ctrl.requestSwipe = async (request) => {
      request.onDispatch?.();
      throw new Error("socket closed");
    };

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
    expect(result.error).toContain("socket closed");
  });

  test("a panel without a prior observation returns a failure result", async () => {
    const { swipeAt } = setup({ panel: "internal" });

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("require a prior observation");
  });

  test("a display transition mid-call returns the typed staleDisplay failure", async () => {
    const { swipeAt, ctrl, transitions } = setup();
    const swipe = ctrl.requestSwipe.bind(ctrl);
    // The panel changes after resolution but before the finger goes down.
    ctrl.requestSwipe = async (...args) => {
      transitions.transition();
      return swipe(...args);
    };

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result.success).toBe(false);
    expect(result.staleDisplay).toMatchObject({ retry: "observe" });
    expect(ctrl.getSwipeHistory()).toEqual([]);
  });

  test("a display change after the prior observation is refused as stale", async () => {
    const { swipeAt, ctrl, transitions } = setup();
    transitions.transition();

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result.success).toBe(false);
    expect(result.staleDisplay).toBeDefined();
    expect(ctrl.getSwipeHistory()).toEqual([]);
  });

  test("points resolve against the selected panel's screen size", async () => {
    const { swipeAt, ctrl } = setup();

    // x 350 is outside the 100 px wide default display but inside the 400 px selected panel.
    const result = await swipeAt.execute({
      display: "external",
      from: { x: 350, y: 700 },
      to: { x: 50, y: 700 },
    });

    expect(result.success).toBe(true);
    expect(ctrl.getSwipeHistory()).toMatchObject([{ x1: 350, y1: 700, x2: 50, y2: 700 }]);
  });

  test("a stale snapshot reference is refused", async () => {
    const { swipeAt, ctrl } = setup();

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
      snapshotId: "missing-snapshot",
    });

    expect(result.success).toBe(false);
    expect(ctrl.getSwipeHistory()).toEqual([]);
  });

  test("iOS refuses display", async () => {
    const { swipeAt, ctrl } = setup({ target: iosDevice });

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Android-only");
    expect(ctrl.getSwipeHistory()).toEqual([]);
  });

  test("a thrown CtrlProxy error before dispatch falls back to adb", async () => {
    const { swipeAt, ctrl, adb } = setup();
    ctrl.requestSwipe = async () => {
      throw new Error("WebSocket not connected");
    };

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands().join("\n")).toContain(
      "input touchscreen -d 2 swipe 10 20 10 150 300",
    );
  });

  test("an aborted signal aborts without an adb fallback", async () => {
    const { swipeAt, ctrl, adb } = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(
      swipeAt.execute(
        { display: "external", from: { x: 10, y: 20 }, to: { x: 10, y: 150 } },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(ctrl.getSwipeHistory()).toEqual([]);
    expect(adb.getExecutedCommands().join("\n")).not.toContain("touchscreen");
  });

  test("a pinned display that cannot be selected keeps the pin details", async () => {
    const { swipeAt } = setup();

    const result = await runWithSelectedDisplayPin(
      { pin: "ghost", inventory: device.displays },
      () => swipeAt.execute({ display: "ghost", from: { x: 10, y: 20 }, to: { x: 10, y: 150 } }),
    );

    expect(result.success).toBe(false);
    expect(result).toHaveProperty("pinnedDisplay");
  });
});
