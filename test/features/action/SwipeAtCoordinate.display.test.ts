import { afterEach, describe, expect, test } from "bun:test";
import { SwipeAtCoordinate } from "../../../src/features/action/SwipeAtCoordinate";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { BootedDevice } from "../../../src/models";
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
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("cmd display get-displays", {
    stdout:
      'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 200}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 400 x 800}',
    stderr: "",
    toString: () => "",
    trim: () => "",
    includes: () => false,
  });
  const ctrl = new FakeCtrlProxy();
  ctrl.setSupportedCommands(capable ? ["gesture_display_id_v1"] : []);
  const observe = new FakeObserveScreen();
  observe.setObserveResult({
    ...observation(width, height),
    display: { key: panel, role: "external", generation: 7 },
  });
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const transitions = new FakeDisplayTransitionReader();
  const renderedRevision = transitions.fullRevision;
  const swipeAt = new SwipeAtCoordinate(target, adb, {
    timer,
    androidClient: ctrl,
    displayTransitions: transitions,
    lastRenderedObservation: () => ({
      display: { key: panel, generation: 7 },
      displayRevision: renderedRevision,
    }),
  });
  swipeAt.window = new FakeWindow();
  swipeAt.observeScreen = observe;
  return { swipeAt, ctrl, adb, transitions, observe };
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

  test("a default-display panel omits the display id", async () => {
    const { swipeAt, ctrl } = setup({ panel: "internal", width: 100, height: 200 });

    const result = await swipeAt.execute({
      display: "internal",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result.success).toBe(true);
    expect(ctrl.getSwipeHistory()[0]).not.toHaveProperty("displayId");
  });

  test("a CtrlProxy without gesture_display_id_v1 fails before any dispatch", async () => {
    const { swipeAt, ctrl } = setup({ capable: false });

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 150 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("gesture_display_id_v1");
    expect(ctrl.getSwipeHistory()).toEqual([]);
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

    const result = await swipeAt.execute({
      display: "external",
      from: { x: 399, y: 10 },
      to: { x: 450, y: 10 },
    });

    expect(result.success).toBe(false);
    expect(ctrl.getSwipeHistory()).toEqual([]);
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
    expect(result.error).toContain("not supported");
    expect(ctrl.getSwipeHistory()).toEqual([]);
  });
});
