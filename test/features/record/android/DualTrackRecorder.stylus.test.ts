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

  test("an eraser gesture cannot be replayed, so it is skipped with a warning", async () => {
    await recorder.start();
    gestures.emit({
      type: "tap",
      arrivedAt: timer.now(),
      screenX: 50,
      screenY: 60,
      toolType: "eraser",
    });

    const result = await recorder.stop();

    expect(result.steps).toEqual([]);
    expect(result.exportWarnings).toEqual([expect.stringContaining("eraser")]);
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

  test("a hover is not exported, and the stop result says it was dropped", async () => {
    await recorder.start();
    gestures.emit({ type: "hover", arrivedAt: timer.now(), toolType: "stylus" });

    const result = await recorder.stop();

    expect(result.steps).toEqual([]);
    expect(result.exportWarnings).toEqual([expect.stringContaining("hover")]);
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
    gestures.emit({ type: "tap", arrivedAt: timer.now(), screenX: 342, screenY: 891 });

    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapOn", params: { action: "tap", elementId: BUTTON["resource-id"] } },
    ]);
  });
});
