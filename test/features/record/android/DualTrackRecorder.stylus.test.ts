import { beforeEach, describe, expect, test } from "bun:test";
import { DualTrackRecorder } from "../../../../src/features/record/android/DualTrackRecorder";
import type {
  A11ySource,
  GestureEmitter,
  GestureEvent,
} from "../../../../src/features/record/android/types";
import type { BootedDevice } from "../../../../src/models";
import { tapAtSchema } from "../../../../src/server/interactionTools";
import { swipeAtSchema } from "../../../../src/server/swipeAtTools";
import { FakeTimer } from "../../../fakes/FakeTimer";

class FakeGestureEmitter implements GestureEmitter {
  private onGesture?: (event: GestureEvent) => void;

  start(onGesture: (event: GestureEvent) => void): void {
    this.onGesture = onGesture;
  }

  stop(): void {
    this.onGesture = undefined;
  }

  emit(event: GestureEvent): void {
    this.onGesture?.(event);
  }
}

type InteractionListener = Parameters<A11ySource["onInteraction"]>[0];

class FakeA11ySource implements A11ySource {
  private listener?: InteractionListener;

  async ensureConnected(): Promise<boolean> {
    return true;
  }

  async getSupportedCommands(): Promise<string[] | null> {
    return ["request_insert_text"];
  }

  onInteraction(listener: InteractionListener): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: Parameters<InteractionListener>[0]): void {
    this.listener?.(event);
  }
}

import { DisplayGeometryTracker } from "../../../../src/features/record/android/DisplayGeometryTracker";
import { ScreenGeometryTimeline } from "../../../../src/features/record/android/ScreenGeometryTimeline";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Test", platform: "android" };

const BUTTON = {
  "resource-id": "com.example:id/login_btn",
  bounds: { left: 300, top: 860, right: 400, bottom: 920 },
};

const STYLUS = { toolType: "stylus" as const };

describe("recorded stylus gestures keep their pointer (#13084)", () => {
  let gestures: FakeGestureEmitter;
  let a11y: FakeA11ySource;
  let timer: FakeTimer;
  let recorder: DualTrackRecorder;

  beforeEach(() => {
    gestures = new FakeGestureEmitter();
    a11y = new FakeA11ySource();
    timer = new FakeTimer();
    recorder = new DualTrackRecorder(device, gestures, a11y, { timer });
  });

  test("labels sampled stroke and hover steps that span a display geometry change", async () => {
    const display = { width: 1080, height: 2400 };
    const timeline = new ScreenGeometryTimeline(
      { xMin: 0, xMax: 32767, yMin: 0, yMax: 32767 },
      { rotation: 0, display },
      timer.now(),
    );
    const geometry = new DisplayGeometryTracker(
      timeline,
      {
        readRotation: async () => 0,
        readPhysicalSize: async () => display,
      },
      timer,
    );
    recorder = new DualTrackRecorder(device, gestures, a11y, { timer, geometry });
    await recorder.start();
    timer.advanceTime(1000);
    const downAt = timer.now();
    timer.advanceTime(100);
    timeline.noteChangeReported(timer.now());
    timer.advanceTime(100);
    gestures.emit({
      type: "stroke",
      toolType: "stylus",
      downAt,
      arrivedAt: timer.now(),
      path: [
        { x: 10, y: 20, pressure: 0.2, arrivedAt: downAt },
        { x: 30, y: 40, pressure: 0.8, arrivedAt: timer.now() },
      ],
    });
    gestures.emit({
      type: "hover",
      toolType: "stylus",
      downAt,
      arrivedAt: timer.now(),
      hover: [
        { x: 10, y: 20, distance: 0.5, arrivedAt: downAt },
        { x: 30, y: 40, distance: 0.5, arrivedAt: timer.now() },
      ],
    });
    const result = await recorder.stop();
    expect(result.steps.map((step) => step.tool)).toEqual(["dragPath", "hoverAt"]);
    expect(result.steps.map((step) => step.label)).toEqual([
      expect.stringContaining("gesture spans a display rotation/size change"),
      expect.stringContaining("gesture spans a display rotation/size change"),
    ]);
    expect(result.geometryWarnings).toEqual([
      expect.stringContaining("gesture spans a display rotation/size change"),
    ]);
  });

  test("stop warns when a known stylus stroke exceeds the replay duration limit", async () => {
    await recorder.start();
    gestures.emit({
      type: "stroke",
      toolType: "stylus",
      arrivedAt: timer.now(),
      path: Array.from({ length: 31 }, (_, index) => ({
        x: index,
        y: 20,
        pressure: index / 30,
        arrivedAt: index * 1000,
      })),
    });
    const result = await recorder.stop();
    expect(result.steps).toEqual([]);
    expect(result.exportWarnings).toEqual([expect.stringContaining("20 second")]);
    expect(result.exportWarnings?.[0]).not.toContain("without a known position or path");
  });

  test("a stylus tap over an element is a tapAt with a pointer, never a tapOn", async () => {
    await recorder.start();
    a11y.emit({ type: "tap", timestamp: timer.now(), element: BUTTON });
    gestures.emit({
      type: "tap",
      arrivedAt: timer.now(),
      screenX: 342,
      screenY: 891,
      ...STYLUS,
    });

    const { steps, exportWarnings } = await recorder.stop();

    expect(steps).toEqual([
      { tool: "tapAt", params: { x: 342, y: 891, action: "tap", pointer: STYLUS } },
    ]);
    expect(exportWarnings).toBeUndefined();
    expect(tapAtSchema.safeParse(steps[0].params).success).toBe(true);
  });

  test.each(["tap", "swipe"] as const)(
    "a stylus %s exports probe pressure, tilt and primary button",
    async (type) => {
      await recorder.start();
      gestures.emit({
        type,
        arrivedAt: 0,
        screenX: 500,
        screenY: 2050,
        startX: 500,
        startY: 2050,
        endX: 700,
        endY: 2050,
        toolType: "stylus",
        pressure: { min: 4000 / 4095, max: 4000 / 4095, mean: 4000 / 4095, normalized: true },
        tilt: 0.55,
        buttons: ["stylusPrimary"],
      });
      const { steps } = await recorder.stop();
      expect(steps).toHaveLength(1);
      expect(steps[0].params.pointer).toEqual({
        toolType: "stylus",
        pressure: 0.9768,
        tilt: 0.55,
        buttons: ["primary"],
      });
      expect(
        (type === "tap" ? tapAtSchema : swipeAtSchema).safeParse(steps[0].params).success,
      ).toBe(true);
    },
  );

  test("raw pressure without an axis range is omitted and both buttons map to replay names", async () => {
    await recorder.start();
    gestures.emit({
      type: "tap",
      arrivedAt: 0,
      screenX: 50,
      screenY: 60,
      toolType: "stylus",
      pressure: { min: 4000, max: 4000, mean: 4000, normalized: false },
      buttons: ["stylusPrimary", "stylusSecondary"],
    });
    expect((await recorder.stop()).steps[0].params.pointer).toEqual({
      toolType: "stylus",
      buttons: ["primary", "secondary"],
    });
  });

  test("a stylus long press keeps its pointer and duration", async () => {
    await recorder.start();
    gestures.emit({
      type: "longPress",
      arrivedAt: timer.now(),
      screenX: 100,
      screenY: 200,
      durationMs: 800,
      ...STYLUS,
    });

    const { steps } = await recorder.stop();

    expect(steps).toEqual([
      {
        tool: "tapAt",
        params: { x: 100, y: 200, action: "longPress", durationMs: 800, pointer: STYLUS },
      },
    ]);
  });

  test("a stylus swipe is a swipeAt with a pointer, never a swipeOn", async () => {
    await recorder.start();
    a11y.emit({
      type: "scroll",
      timestamp: timer.now(),
      element: BUTTON,
      scrollDeltaY: 100,
    });
    gestures.emit({
      type: "swipe",
      arrivedAt: timer.now(),
      startX: 200,
      startY: 900,
      endX: 210,
      endY: 300,
      direction: "up",
      ...STYLUS,
    });

    const { steps } = await recorder.stop();

    expect(steps).toEqual([
      {
        tool: "swipeAt",
        params: { from: { x: 200, y: 900 }, to: { x: 210, y: 300 }, pointer: STYLUS },
      },
    ]);
    expect(swipeAtSchema.safeParse(steps[0].params).success).toBe(true);
  });

  test("a stylus swipe whose path is unknown is skipped, not exported as a finger swipe", async () => {
    await recorder.start();
    a11y.emit({ type: "scroll", timestamp: timer.now(), element: BUTTON, scrollDeltaY: 100 });
    gestures.emit({
      type: "swipe",
      arrivedAt: timer.now(),
      direction: "up",
      unknownAxes: ["y"],
      ...STYLUS,
    });

    const result = await recorder.stop();

    expect(result.steps).toEqual([]);
    expect(result.exportWarnings).toEqual([expect.stringContaining("not exported")]);
  });

  test("a stylus tap with unknown axes is not rescued into a finger swipe", async () => {
    await recorder.start();
    a11y.emit({ type: "scroll", timestamp: timer.now(), element: BUTTON, scrollDeltaY: 100 });
    gestures.emit({ type: "tap", arrivedAt: timer.now(), unknownAxes: ["y"], ...STYLUS });

    const result = await recorder.stop();

    expect(result.steps).toEqual([]);
    expect(result.exportWarnings).toEqual([expect.stringContaining("not exported")]);
  });

  test("a stylus swipe that never moved is skipped with a warning", async () => {
    await recorder.start();
    gestures.emit({
      type: "swipe",
      arrivedAt: timer.now(),
      startX: 5,
      startY: 6,
      endX: 5,
      endY: 6,
      direction: "up",
      ...STYLUS,
    });

    const result = await recorder.stop();

    expect(result.steps).toEqual([]);
    expect(result.exportWarnings).toEqual([expect.stringContaining("not exported")]);
  });

  test("an eraser gesture exports as an eraser step with a replay warning (#13105)", async () => {
    await recorder.start();
    gestures.emit({
      type: "tap",
      arrivedAt: timer.now(),
      screenX: 50,
      screenY: 60,
      toolType: "eraser",
      pressure: { min: 0.98, max: 0.98, mean: 0.98, normalized: true },
      tilt: 0.55,
      buttons: ["stylusPrimary"],
    });

    const result = await recorder.stop();

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      tool: "tapAt",
      params: { x: 50, y: 60, pointer: { toolType: "eraser", pressure: 0.98, tilt: 0.55 } },
    });
    expect(result.exportWarnings).toEqual([expect.stringContaining("root adb shell")]);
  });

  test("a stylus double tap upgrades only a stylus tap, and keeps the pointer", async () => {
    await recorder.start();
    gestures.emit({ type: "tap", arrivedAt: 0, screenX: 10, screenY: 20, ...STYLUS });
    gestures.emit({
      type: "doubleTap",
      arrivedAt: 100,
      firstTapArrivedAt: 0,
      screenX: 10,
      screenY: 20,
      ...STYLUS,
    });

    const result = await recorder.stop();

    expect(result.steps).toEqual([
      { tool: "tapAt", params: { x: 10, y: 20, action: "doubleTap", pointer: STYLUS } },
    ]);
    // Replay refuses a stylus double tap, so recording says so instead of leaving it for replay.
    expect(result.exportWarnings).toEqual([expect.stringContaining("double tap")]);
  });

  test("a standalone stylus double tap warns that replay will refuse it", async () => {
    await recorder.start();
    gestures.emit({
      type: "doubleTap",
      arrivedAt: timer.now(),
      screenX: 10,
      screenY: 20,
      ...STYLUS,
    });

    const result = await recorder.stop();

    expect(result.steps).toEqual([
      { tool: "tapAt", params: { x: 10, y: 20, action: "doubleTap", pointer: STYLUS } },
    ]);
    expect(result.exportWarnings).toEqual([expect.stringContaining("double tap")]);
  });

  test("a finger double tap does not upgrade a stylus tap at the same spot", async () => {
    await recorder.start();
    gestures.emit({ type: "tap", arrivedAt: 0, screenX: 10, screenY: 20, ...STYLUS });
    gestures.emit({
      type: "doubleTap",
      arrivedAt: 100,
      screenX: 10,
      screenY: 20,
    });

    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapAt", params: { x: 10, y: 20, action: "tap", pointer: STYLUS } },
      { tool: "tapAt", params: { x: 10, y: 20, action: "doubleTap" } },
    ]);
  });

  test("a hover without a known position is not exported and warns", async () => {
    await recorder.start();
    gestures.emit({ type: "hover", arrivedAt: timer.now(), toolType: "stylus" });

    const result = await recorder.stop();

    expect(result.steps).toEqual([]);
    expect(result.exportWarnings).toEqual([expect.stringContaining("hover")]);
  });

  test("a positioned hover without distance warns instead of exporting a touch", async () => {
    await recorder.start();
    gestures.emit({
      type: "hover",
      arrivedAt: timer.now(),
      toolType: "stylus",
      screenX: 10,
      screenY: 20,
    });
    const result = await recorder.stop();
    expect(result.steps).toEqual([]);
    expect(result.exportWarnings).toEqual([expect.stringContaining("hover distance")]);
  });

  test("hovers next to a tap warn once and leave the tap exported", async () => {
    await recorder.start();
    gestures.emit({ type: "hover", arrivedAt: timer.now(), toolType: "stylus" });
    gestures.emit({ type: "tap", arrivedAt: timer.now(), screenX: 5, screenY: 6, ...STYLUS });
    gestures.emit({ type: "hover", arrivedAt: timer.now(), toolType: "stylus" });

    const result = await recorder.stop();

    expect(result.steps).toEqual([
      { tool: "tapAt", params: { x: 5, y: 6, action: "tap", pointer: STYLUS } },
    ]);
    expect(result.exportWarnings).toEqual([expect.stringContaining("hover")]);
  });

  test("finger gestures export exactly as before", async () => {
    await recorder.start();
    a11y.emit({ type: "tap", timestamp: timer.now(), element: BUTTON });
    gestures.emit({
      type: "tap",
      arrivedAt: timer.now(),
      screenX: 342,
      screenY: 891,
      pressure: { min: 0.98, max: 0.98, mean: 0.98, normalized: true },
      tilt: 0.55,
      buttons: ["stylusPrimary"],
    });

    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapOn", params: { action: "tap", elementId: BUTTON["resource-id"] } },
    ]);
  });
});
