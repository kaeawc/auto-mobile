import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import {
  DualTrackRecorder,
  MERGE_WINDOW_MS,
  resolveSwipeDirection,
} from "../../../../src/features/record/android/DualTrackRecorder";
import type {
  GestureEmitter,
  GestureEvent,
  A11ySource,
} from "../../../../src/features/record/android/types";
import type { BootedDevice } from "../../../../src/models";
import { sendKeysSchema } from "../../../../src/server/interactionTools";
import { logger } from "../../../../src/utils/logger";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { GestureClassifier } from "../../../../src/features/record/android/GestureClassifier";
import { TouchFrameReconstructor } from "../../../../src/features/record/android/TouchFrameReconstructor";
import type { RawTouchFrame } from "../../../../src/features/record/android/types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type InteractionListener = (event: { type: string; [key: string]: unknown }) => void;

class FakeGestureEmitter implements GestureEmitter {
  startCount = 0;
  stopCount = 0;
  private onGestureHandler?: (event: GestureEvent) => void;
  onError?: (err: Error) => void;

  start(onGesture: (event: GestureEvent) => void, onError?: (err: Error) => void): void {
    this.startCount++;
    this.onError = onError;
    this.onGestureHandler = onGesture;
  }

  stop(): void {
    this.stopCount++;
    this.onGestureHandler = undefined;
  }

  emit(event: GestureEvent): void {
    this.onGestureHandler?.(event);
  }
}

class FakeA11ySource implements A11ySource {
  connectionError: Error | undefined;
  connected = true;
  subscriptionCount = 0;
  unsubscribeCount = 0;
  private listener?: InteractionListener;

  async ensureConnected(): Promise<boolean> {
    if (this.connectionError) {
      throw this.connectionError;
    }
    return this.connected;
  }

  async getSupportedCommands(): Promise<string[] | null> {
    return ["request_insert_text"];
  }

  onInteraction(listener: InteractionListener): () => void {
    this.subscriptionCount++;
    this.listener = listener;
    return () => {
      this.unsubscribeCount++;
      this.listener = undefined;
    };
  }

  emit(event: { type: string; [key: string]: unknown }): void {
    this.listener?.(event);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Test Device",
  platform: "android",
};

const TAP_ELEMENT = {
  "resource-id": "com.example:id/login_btn",
  bounds: { left: 300, top: 860, right: 400, bottom: 920 },
};

function touchFrame(
  arrivedAt: number,
  activeSlots: Array<Omit<RawTouchFrame["activeSlots"][number], "pressure">>,
  releasedSlots: number[] = [],
): RawTouchFrame {
  return {
    arrivedAt,
    activeSlots: activeSlots.map((slot) => ({ ...slot, pressure: 0 })),
    releasedSlots,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DualTrackRecorder", () => {
  let fakeGestures: FakeGestureEmitter;
  let fakeA11y: FakeA11ySource;
  let fakeTimer: FakeTimer;
  let recorder: DualTrackRecorder;

  beforeEach(() => {
    fakeGestures = new FakeGestureEmitter();
    fakeA11y = new FakeA11ySource();
    fakeTimer = new FakeTimer();
    recorder = new DualTrackRecorder(fakeDevice, fakeGestures, fakeA11y, fakeTimer);
  });

  test.each([
    { x: 280, y: 840, hit: true },
    { x: 420, y: 940, hit: true },
    { x: 279, y: 891, hit: false },
    { x: 421, y: 891, hit: false },
    { x: 342, y: 839, hit: false },
    { x: 342, y: 941, hit: false },
  ])("pins padded hit boundary at $x,$y", async ({ x, y, hit }) => {
    await recorder.start();
    fakeA11y.emit({ type: "tap", timestamp: fakeTimer.now(), element: TAP_ELEMENT });
    fakeGestures.emit({ type: "tap", arrivedAt: fakeTimer.now(), screenX: x, screenY: y });
    expect((await recorder.stop()).steps).toEqual(
      hit
        ? [{ tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } }]
        : [{ tool: "tapAt", params: { x, y, action: "tap" } }],
    );
    expect(fakeGestures.startCount).toBe(1);
    expect(fakeGestures.stopCount).toBe(1);
    expect(fakeA11y.unsubscribeCount).toBe(1);
  });

  test("retains the first touch-track failure with injected timing through stop", async () => {
    fakeTimer.advanceTime(10_000);
    await recorder.start();
    fakeTimer.advanceTime(1250);
    const error = new Error("getevent exited with code 1");
    fakeGestures.onError?.(error);
    fakeTimer.advanceTime(100);
    fakeGestures.onError?.(new Error("later error"));
    expect(recorder.touchTrackFailure).toEqual({ error, failedAt: 11_250 });
    const result = await recorder.stop();
    expect(result.touchTrackFailure).toEqual({ error, failedAt: 11_250 });
    expect(await recorder.stop()).toEqual(result);
  });

  test("normal stop keeps the result shape and ignores shutdown errors", async () => {
    await recorder.start();
    const stop = spyOn(fakeGestures, "stop").mockImplementation(() => {
      fakeGestures.onError?.(new Error("getevent killed by caller"));
    });
    try {
      expect(await recorder.stop()).toEqual({ steps: [], stepCount: 0 });
      expect(recorder.touchTrackFailure).toBeUndefined();
    } finally {
      stop.mockRestore();
    }
  });

  test("S1 known hit wins over an earlier unknown tap", async () => {
    await recorder.start();
    const warning = spyOn(logger, "warn");
    try {
      fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["y"] });
      fakeTimer.advanceTime(300);
      fakeGestures.emit({ type: "tap", arrivedAt: 300, screenX: 342, screenY: 891 });
      fakeTimer.advanceTime(50);
      fakeA11y.emit({ type: "tap", timestamp: 350, element: TAP_ELEMENT });
      expect((await recorder.stop()).steps).toEqual([
        { tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } },
      ]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("tap has unknown axes: y"));
    } finally {
      warning.mockRestore();
    }
  });

  test("S3 unknown tap rejects an unrelated Clock stateChange", async () => {
    await recorder.start();
    const warning = spyOn(logger, "warn");
    try {
      fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["x"] });
      fakeA11y.emit({
        type: "stateChange",
        timestamp: 0,
        element: {
          text: "Clock 12:01",
          bounds: TAP_ELEMENT.bounds,
        },
      });
      expect((await recorder.stop()).steps).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("tap has unknown axes: x"));
    } finally {
      warning.mockRestore();
    }
  });

  test("two unknown contacts cannot share one click", async () => {
    await recorder.start();
    const warning = spyOn(logger, "warn");
    try {
      fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["x"] });
      fakeTimer.advanceTime(300);
      fakeGestures.emit({ type: "tap", arrivedAt: 300, unknownAxes: ["y"] });
      fakeA11y.emit({ type: "tap", timestamp: 300, element: TAP_ELEMENT });
      // Serial timeouts must not make the second contact appear unambiguous.
      fakeTimer.advanceTime(MERGE_WINDOW_MS);
      expect((await recorder.stop()).steps).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("unknown axes: x"));
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("unknown axes: y"));
    } finally {
      warning.mockRestore();
    }
  });

  test("unknown tap with two click candidates is dropped", async () => {
    await recorder.start();
    const warning = spyOn(logger, "warn");
    try {
      fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["y"] });
      fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
      fakeTimer.advanceTime(100);
      fakeA11y.emit({
        type: "tap",
        timestamp: 100,
        element: {
          ...TAP_ELEMENT,
          "resource-id": "com.example:id/other_btn",
        },
      });
      expect((await recorder.stop()).steps).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("tap has unknown axes: y"));
    } finally {
      warning.mockRestore();
    }
  });

  test.each([true, false])(
    "real first-touch drag is a swipe (scroll event: %s)",
    async (scroll) => {
      await recorder.start();
      const warning = spyOn(logger, "warn");
      try {
        const reconstructor = new TouchFrameReconstructor();
        const classifier = new GestureClassifier(
          {
            toScreenPoint: (x, y) => {
              expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
              return { x, y };
            },
          },
          1,
        );
        const frames = [
          ["ABS_MT_TRACKING_ID 00000001", "ABS_MT_POSITION_X 00000156"],
          ["ABS_MT_POSITION_Y 00000300"],
          ["ABS_MT_POSITION_Y 00000600"],
          ["ABS_MT_TRACKING_ID ffffffff"],
        ];
        const gestures: GestureEvent[] = [];
        for (const events of frames) {
          for (const event of events) {
            reconstructor.feedLine(`[ 1.0] EV_ABS ${event}`, fakeTimer.now());
          }
          const frame = reconstructor.feedLine(
            "[ 1.0] EV_SYN SYN_REPORT 00000000",
            fakeTimer.now(),
          );
          if (frame && "activeSlots" in frame) {
            const gesture = classifier.feedFrame(frame);
            if (gesture) {
              gestures.push(gesture);
              fakeGestures.emit(gesture);
            }
          }
          fakeTimer.advanceTime(20);
        }
        expect(gestures).toEqual([
          { type: "swipe", arrivedAt: 60, durationMs: 60, unknownAxes: ["y"] },
        ]);
        if (scroll) {
          fakeA11y.emit({ type: "scroll", timestamp: 80, element: TAP_ELEMENT, scrollDeltaY: 100 });
        }
        expect((await recorder.stop()).steps).toEqual(
          scroll
            ? [
                {
                  tool: "swipeOn",
                  params: { direction: "up", container: { elementId: TAP_ELEMENT["resource-id"] } },
                },
              ]
            : [],
        );
        if (!scroll) {
          expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("swipe has unknown axes: y"),
          );
        }
      } finally {
        warning.mockRestore();
      }
    },
  );

  // Logic tests: available captures do not contain an unreported-axis scroll.
  test.each([
    ["y", 50, true],
    ["x", 50, true],
    ["y", 500, true],
    ["x", 500, true],
    ["y", 50, false],
    ["x", 50, false],
    ["y", 500, false],
    ["x", 500, false],
  ] as const)(
    "unreported %s axis with low displacement (%d ms, directional scroll: %s)",
    async (axis, durationMs, scroll) => {
      await recorder.start();
      const classifier = new GestureClassifier({ toScreenPoint: (x, y) => ({ x, y }) }, 1);
      const slot = {
        slotId: 0,
        trackingId: 1,
        x: axis === "x" ? NaN : 342,
        y: axis === "y" ? NaN : 891,
        unknownAxes: [axis],
      };
      classifier.feedFrame(touchFrame(0, [slot]));
      fakeTimer.advanceTime(20);
      classifier.feedFrame(
        touchFrame(fakeTimer.now(), [{ ...slot, x: slot.x + 2, y: slot.y + 2 }]),
      );
      fakeTimer.advanceTime(durationMs - 20);
      const gesture = classifier.feedFrame(touchFrame(fakeTimer.now(), [], [0]));
      const action = durationMs < 400 ? "tap" : "longPress";
      expect(gesture).toEqual({
        type: action,
        arrivedAt: durationMs,
        durationMs,
        unknownAxes: [axis],
      });
      if (!gesture) {
        throw new Error("Expected a completed contact");
      }
      fakeGestures.emit(gesture);
      fakeTimer.advanceTime(360);
      fakeA11y.emit({
        type: scroll ? "scroll" : action,
        timestamp: durationMs,
        element: TAP_ELEMENT,
        ...(scroll ? (axis === "y" ? { scrollDeltaY: 100 } : { scrollDeltaX: 100 }) : {}),
      });
      // Unknown contacts must wait for later ambiguity witnesses.
      expect(recorder.stepCount).toBe(0);
      fakeTimer.advanceTime(MERGE_WINDOW_MS - 360);
      expect((await recorder.stop()).steps).toEqual([
        scroll
          ? {
              tool: "swipeOn",
              params: {
                direction: axis === "y" ? "up" : "left",
                container: { elementId: TAP_ELEMENT["resource-id"] },
              },
            }
          : { tool: "tapOn", params: { action, elementId: TAP_ELEMENT["resource-id"] } },
      ]);
    },
  );

  test("buffered directional scroll resolves an unknown-axis tap", async () => {
    await recorder.start();
    fakeA11y.emit({ type: "scroll", timestamp: 0, element: TAP_ELEMENT, scrollDeltaY: -100 });
    fakeTimer.advanceTime(50);
    fakeGestures.emit({ type: "tap", arrivedAt: 50, unknownAxes: ["y"] });
    expect((await recorder.stop()).steps).toEqual([
      {
        tool: "swipeOn",
        params: { direction: "down", container: { elementId: TAP_ELEMENT["resource-id"] } },
      },
    ]);
  });

  test.each(["scroll", "tap"])(
    "unknown-axis tap drops ambiguous scroll and %s candidates",
    async (otherType) => {
      await recorder.start();
      const warning = spyOn(logger, "warn");
      try {
        fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["y"] });
        fakeA11y.emit({ type: "scroll", timestamp: 0, element: TAP_ELEMENT, scrollDeltaY: 100 });
        fakeTimer.advanceTime(100);
        fakeA11y.emit({
          type: otherType,
          timestamp: 100,
          element: TAP_ELEMENT,
          scrollDeltaY: -100,
        });
        fakeTimer.advanceTime(MERGE_WINDOW_MS);
        expect((await recorder.stop()).steps).toEqual([]);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("tap has unknown axes: y"));
      } finally {
        warning.mockRestore();
      }
    },
  );

  test.each([false, true])(
    "zero-delta scroll cannot promote unknown-axis tap (click: %s)",
    async (click) => {
      await recorder.start();
      const warning = spyOn(logger, "warn");
      try {
        fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["y"] });
        fakeA11y.emit({
          type: "scroll",
          timestamp: 0,
          element: TAP_ELEMENT,
          scrollDeltaX: 0,
          scrollDeltaY: 0,
        });
        if (click) {
          fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
        }
        expect((await recorder.stop()).steps).toEqual(
          click
            ? [{ tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } }]
            : [],
        );
        if (!click) {
          expect(warning).toHaveBeenCalledWith(expect.stringContaining("tap has unknown axes: y"));
        }
      } finally {
        warning.mockRestore();
      }
    },
  );

  test.each([true, false])(
    "known swipe claims scroll over unknown tap (scroll buffered: %s)",
    async (buffered) => {
      await recorder.start();
      const warning = spyOn(logger, "warn");
      try {
        fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["y"] });
        if (buffered) {
          fakeA11y.emit({ type: "scroll", timestamp: 0, element: TAP_ELEMENT, scrollDeltaY: 100 });
        }
        fakeTimer.advanceTime(100);
        fakeGestures.emit({
          type: "swipe",
          arrivedAt: 100,
          startX: 342,
          startY: 891,
          direction: "down",
        });
        if (!buffered) {
          fakeA11y.emit({
            type: "scroll",
            timestamp: 100,
            element: TAP_ELEMENT,
            scrollDeltaY: 100,
          });
        }
        fakeTimer.advanceTime(MERGE_WINDOW_MS);
        expect((await recorder.stop()).steps).toEqual([
          {
            tool: "swipeOn",
            params: { direction: "down", container: { elementId: TAP_ELEMENT["resource-id"] } },
          },
        ]);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("tap has unknown axes: y"));
      } finally {
        warning.mockRestore();
      }
    },
  );

  test("two unknown contacts cannot share a directional scroll across serial timeouts", async () => {
    await recorder.start();
    const warning = spyOn(logger, "warn");
    try {
      fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["y"] });
      fakeTimer.advanceTime(300);
      fakeGestures.emit({ type: "longPress", arrivedAt: 300, unknownAxes: ["x"] });
      fakeA11y.emit({ type: "scroll", timestamp: 300, element: TAP_ELEMENT, scrollDeltaY: 100 });
      fakeTimer.advanceTime(MERGE_WINDOW_MS);
      expect((await recorder.stop()).steps).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("tap has unknown axes: y"));
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("longPress has unknown axes: x"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  test.each(["stateChange", "swipe"])(
    "%s with directional deltas cannot promote an unknown-axis tap",
    async (type) => {
      await recorder.start();
      const warning = spyOn(logger, "warn");
      try {
        fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["y"] });
        fakeA11y.emit({ type, timestamp: 0, element: TAP_ELEMENT, scrollDeltaY: 100 });
        expect((await recorder.stop()).steps).toEqual([]);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("tap has unknown axes: y"));
      } finally {
        warning.mockRestore();
      }
    },
  );

  test.each(["doubleTap", "tap"] as const)(
    "scroll cannot promote %s with complete coordinates",
    async (type) => {
      await recorder.start();
      fakeGestures.emit({ type, arrivedAt: 0, screenX: 342, screenY: 891 });
      fakeA11y.emit({ type: "scroll", timestamp: 0, element: TAP_ELEMENT, scrollDeltaY: 100 });
      expect((await recorder.stop()).steps).toEqual([
        { tool: "tapAt", params: { action: type, x: 342, y: 891 } },
      ]);
    },
  );

  test("scroll cannot promote an unknown-axis double tap", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "doubleTap", arrivedAt: 0, unknownAxes: ["y"] });
    fakeA11y.emit({ type: "scroll", timestamp: 0, element: TAP_ELEMENT, scrollDeltaY: 100 });
    expect((await recorder.stop()).steps).toEqual([]);
  });

  test.each([{ bounds: TAP_ELEMENT.bounds }, { "resource-id": TAP_ELEMENT["resource-id"] }])(
    "scroll needs both bounds and a selector to promote an unknown tap (%p)",
    async (element) => {
      await recorder.start();
      fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["y"] });
      fakeA11y.emit({ type: "scroll", timestamp: 0, element, scrollDeltaY: 100 });
      expect((await recorder.stop()).steps).toEqual([]);
    },
  );

  test("stale scroll cannot promote an unknown-axis tap", async () => {
    await recorder.start();
    fakeA11y.emit({ type: "scroll", timestamp: 0, element: TAP_ELEMENT, scrollDeltaY: 100 });
    fakeTimer.advanceTime(MERGE_WINDOW_MS + 1);
    fakeGestures.emit({ type: "tap", arrivedAt: fakeTimer.now(), unknownAxes: ["y"] });
    expect((await recorder.stop()).steps).toEqual([]);
  });

  test.each(["tap", "doubleTap", "longPress"] as const)(
    "unknown-axis %s uses a paired accessibility element",
    async (type) => {
      await recorder.start();
      fakeGestures.emit({ type, arrivedAt: 0, unknownAxes: ["x", "y"] });
      fakeTimer.advanceTime(360);
      fakeA11y.emit({
        type: type === "longPress" ? "longPress" : "tap",
        timestamp: 0,
        element: TAP_ELEMENT,
      });
      expect((await recorder.stop()).steps).toEqual([
        { tool: "tapOn", params: { action: type, elementId: TAP_ELEMENT["resource-id"] } },
      ]);
    },
  );

  test.each(["x", "y", "both"] as const)(
    "unpaired unknown-axis tap warns naming %s and skips",
    async (axis) => {
      await recorder.start();
      const warning = spyOn(logger, "warn");
      try {
        fakeGestures.emit({
          type: "tap",
          arrivedAt: 0,
          screenX: 0,
          screenY: 0,
          unknownAxes: axis === "both" ? ["x", "y"] : [axis],
        });
        fakeTimer.advanceTime(MERGE_WINDOW_MS);
        expect((await recorder.stop()).steps).toEqual([]);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(`unknown axes: ${axis === "both" ? "x, y" : axis}`),
        );
      } finally {
        warning.mockRestore();
      }
    },
  );

  test("buffered accessibility element resolves unknown axes within the merge window", async () => {
    await recorder.start();
    fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
    fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["y"] });
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } },
    ]);
  });

  test("stale buffered element cannot resolve unknown axes", async () => {
    await recorder.start();
    fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
    fakeTimer.advanceTime(MERGE_WINDOW_MS + 1);
    fakeGestures.emit({ type: "tap", arrivedAt: fakeTimer.now(), unknownAxes: ["x"] });
    expect((await recorder.stop()).steps).toEqual([]);
  });

  test("bounds without a selector cannot resolve an unknown-axis tap", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 0, unknownAxes: ["y"] });
    fakeA11y.emit({ type: "tap", timestamp: 0, element: { bounds: TAP_ELEMENT.bounds } });
    expect((await recorder.stop()).steps).toEqual([]);
  });

  test.each(["longPress", "doubleTap", "swipe", "pinch"] as const)(
    "unpaired unknown-axis %s is dropped",
    async (type) => {
      await recorder.start();
      fakeGestures.emit({
        type,
        arrivedAt: 0,
        screenX: 0,
        screenY: 0,
        direction: "up",
        scale: 0.5,
        unknownAxes: ["x"],
      });
      expect((await recorder.stop()).steps).toEqual([]);
    },
  );

  test("unknown-axis swipe uses only the paired accessibility scroll direction", async () => {
    await recorder.start();
    fakeGestures.emit({
      type: "swipe",
      arrivedAt: 0,
      direction: "right",
      speed: "fast",
      unknownAxes: ["x"],
    });
    fakeA11y.emit({ type: "scroll", timestamp: 0, element: TAP_ELEMENT, scrollDeltaY: 100 });
    expect((await recorder.stop()).steps).toEqual([
      {
        tool: "swipeOn",
        params: { direction: "up", container: { elementId: TAP_ELEMENT["resource-id"] } },
      },
    ]);
  });

  test("unknown-axis swipe without accessibility direction is dropped", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "swipe", arrivedAt: 0, direction: "right", unknownAxes: ["y"] });
    fakeA11y.emit({ type: "scroll", timestamp: 0, element: TAP_ELEMENT });
    expect((await recorder.stop()).steps).toEqual([]);
  });

  test("unknown-axis double tap cannot upgrade a known coordinate fallback", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 891 });
    fakeTimer.advanceTime(MERGE_WINDOW_MS);
    fakeGestures.emit({
      type: "doubleTap",
      arrivedAt: 150,
      firstTapArrivedAt: 0,
      screenX: 342,
      screenY: 0,
      unknownAxes: ["y"],
    });
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapAt", params: { x: 342, y: 891, action: "tap" } },
    ]);
  });

  test("dropping an unknown-axis gesture releases later ordered steps", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: 0, unknownAxes: ["x", "y"] });
    fakeGestures.emit({ type: "pressButton", arrivedAt: 10, button: "back" });
    expect(recorder.stepCount).toBe(0);
    fakeTimer.advanceTime(MERGE_WINDOW_MS);
    expect((await recorder.stop()).steps).toEqual([
      { tool: "pressButton", params: { button: "back" } },
    ]);
  });

  // Issue #9142 supplies measured host delays, not a captured getevent +
  // interaction trace fixture. These deterministic cases exercise those timings.
  test.each([220, 360])("tap merges an accessibility tap delayed by %d ms", async (delay) => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: fakeTimer.now(), screenX: 342, screenY: 891 });
    fakeTimer.advanceTime(delay);
    expect(recorder.stepCount).toBe(0);
    fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
    expect(recorder.stepCount).toBe(1);
    const { steps } = await recorder.stop();
    expect(steps).toEqual([
      { tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } },
    ]);
  });

  test.each(["tap", "doubleTap", "longPress"] as const)(
    "unmatched %s records coordinates at the deadline exactly once",
    async (type) => {
      await recorder.start();
      fakeGestures.emit({
        type,
        arrivedAt: fakeTimer.now(),
        screenX: 342,
        screenY: 891,
        ...(type === "longPress" ? { durationMs: 800 } : {}),
      });
      fakeTimer.advanceTime(MERGE_WINDOW_MS - 1);
      expect(recorder.stepCount).toBe(0);
      fakeTimer.advanceTime(1);
      expect(recorder.stepCount).toBe(1);
      const { steps } = await recorder.stop();
      expect(steps).toEqual([
        {
          tool: "tapAt",
          params: {
            x: 342,
            y: 891,
            action: type,
            ...(type === "longPress" ? { durationMs: 800 } : {}),
          },
        },
      ]);
    },
  );

  test.each(["same", "different"])(
    "two quick taps pair with interleaved events on %s targets in gesture order",
    async (targets) => {
      await recorder.start();
      const second =
        targets === "same"
          ? TAP_ELEMENT
          : {
              "resource-id": "com.example:id/second",
              bounds: { left: 600, top: 860, right: 700, bottom: 920 },
            };
      fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 891 });
      fakeTimer.advanceTime(50);
      fakeGestures.emit({
        type: "tap",
        arrivedAt: 50,
        screenX: targets === "same" ? 350 : 650,
        screenY: 891,
      });
      fakeTimer.advanceTime(220);
      fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
      expect(recorder.stepCount).toBe(1);
      fakeTimer.advanceTime(50);
      fakeA11y.emit({ type: "tap", timestamp: 50, element: second });
      expect(recorder.stepCount).toBe(2);
      const { steps } = await recorder.stop();
      expect(steps.map((step) => step.params.elementId)).toEqual([
        TAP_ELEMENT["resource-id"],
        second["resource-id"],
      ]);
      expect(steps.every((step) => step.tool === "tapOn")).toBe(true);
    },
  );

  test.each(["tap", "doubleTap"] as const)(
    "Compose stateChange alone identifies a %s",
    async (type) => {
      await recorder.start();
      fakeGestures.emit({ type, arrivedAt: 0, screenX: 342, screenY: 891 });
      fakeTimer.advanceTime(360);
      fakeA11y.emit({
        type: "stateChange",
        timestamp: 0,
        element: { ...TAP_ELEMENT, clickable: true },
      });
      expect(recorder.stepCount).toBe(1);
      expect((await recorder.stop()).steps).toEqual([
        { tool: "tapOn", params: { action: type, elementId: TAP_ELEMENT["resource-id"] } },
      ]);
    },
  );

  test.each(["deadline", "stop"])(
    "an unmatched tap stays before a later resolved swipe when flushed by %s",
    async (flush) => {
      await recorder.start();
      fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 10, screenY: 10 });
      fakeTimer.advanceTime(100);
      fakeGestures.emit({
        type: "swipe",
        arrivedAt: 100,
        startX: 500,
        startY: 800,
        direction: "up",
      });
      fakeTimer.advanceTime(200);
      fakeA11y.emit({
        type: "scroll",
        timestamp: 100,
        element: {
          "resource-id": "com.example:id/list",
          bounds: { left: 400, top: 700, right: 600, bottom: 900 },
        },
      });
      expect(recorder.stepCount).toBe(0);
      if (flush === "deadline") {
        fakeTimer.advanceTime(MERGE_WINDOW_MS - fakeTimer.now());
        expect(recorder.stepCount).toBe(2);
      }
      const result = await recorder.stop();
      expect(result.steps).toEqual([
        { tool: "tapAt", params: { x: 10, y: 10, action: "tap" } },
        {
          tool: "swipeOn",
          params: { direction: "up", container: { elementId: "com.example:id/list" } },
        },
      ]);
      expect(result.stepCount).toBe(2);
      expect((await recorder.stop()).steps).toEqual(result.steps);
      fakeTimer.advanceTime(MERGE_WINDOW_MS);
      expect(recorder.stepCount).toBe(2);
    },
  );

  test("a resolved third tap waits for the unmatched middle tap", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 891 });
    fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
    fakeTimer.advanceTime(100);
    fakeGestures.emit({ type: "tap", arrivedAt: 100, screenX: 10, screenY: 10 });
    fakeTimer.advanceTime(100);
    fakeGestures.emit({ type: "tap", arrivedAt: 200, screenX: 650, screenY: 891 });
    fakeTimer.advanceTime(100);
    fakeA11y.emit({
      type: "tap",
      timestamp: 200,
      element: {
        "resource-id": "com.example:id/third",
        bounds: { left: 600, top: 860, right: 700, bottom: 920 },
      },
    });
    expect(recorder.stepCount).toBe(1);
    fakeTimer.advanceTime(100 + MERGE_WINDOW_MS - fakeTimer.now());
    expect(recorder.stepCount).toBe(3);
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } },
      { tool: "tapAt", params: { x: 10, y: 10, action: "tap" } },
      { tool: "tapOn", params: { action: "tap", elementId: "com.example:id/third" } },
    ]);
  });

  test.each(["held", "emitted"])(
    "doubleTap upgrades the correct %s step across a pending gesture",
    async (position) => {
      await recorder.start();
      const unmatchedTap = { type: "tap" as const, arrivedAt: 0, screenX: 10, screenY: 10 };
      if (position === "held") {
        fakeGestures.emit(unmatchedTap);
      }
      fakeTimer.advanceTime(100);
      fakeGestures.emit({ type: "tap", arrivedAt: 100, screenX: 342, screenY: 891 });
      fakeA11y.emit({ type: "tap", timestamp: 100, element: TAP_ELEMENT });
      expect(recorder.stepCount).toBe(position === "held" ? 0 : 1);
      if (position === "emitted") {
        fakeTimer.advanceTime(50);
        fakeGestures.emit({ ...unmatchedTap, arrivedAt: 150 });
      }
      fakeTimer.advanceTime(200 - fakeTimer.now());
      fakeGestures.emit({
        type: "doubleTap",
        arrivedAt: 200,
        firstTapArrivedAt: 100,
        screenX: 342,
        screenY: 891,
      });
      const fallback = { tool: "tapAt", params: { x: 10, y: 10, action: "tap" } };
      const doubleTap = {
        tool: "tapOn",
        params: { action: "doubleTap", elementId: TAP_ELEMENT["resource-id"] },
      };
      expect((await recorder.stop()).steps).toEqual(
        position === "held" ? [fallback, doubleTap] : [doubleTap, fallback],
      );
      expect(recorder.stepCount).toBe(2);
    },
  );

  test("stop resolves several pending gestures in touch order", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 10, screenY: 10 });
    fakeTimer.advanceTime(100);
    fakeGestures.emit({ type: "swipe", arrivedAt: 100, startX: 500, startY: 800, direction: "up" });
    fakeTimer.advanceTime(100);
    fakeGestures.emit({
      type: "longPress",
      arrivedAt: 200,
      screenX: 20,
      screenY: 20,
      durationMs: 800,
    });
    expect(recorder.stepCount).toBe(0);
    expect(await recorder.stop()).toEqual({
      steps: [
        { tool: "tapAt", params: { x: 10, y: 10, action: "tap" } },
        { tool: "swipeOn", params: { direction: "up" } },
        { tool: "tapAt", params: { x: 20, y: 20, action: "longPress", durationMs: 800 } },
      ],
      stepCount: 3,
    });
  });

  test("buttons, pinch and coalesced text wait behind earlier touches", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 10, screenY: 10 });
    fakeGestures.emit({ type: "pressButton", arrivedAt: 0, button: "back" });
    fakeGestures.emit({ type: "pinch", arrivedAt: 0, pinchDirection: "in", scale: 0.5 });
    const element = { "resource-id": "com.example:id/search" };
    fakeA11y.emit({ type: "inputText", timestamp: 0, text: "h", element });
    fakeA11y.emit({ type: "inputText", timestamp: 0, text: "hello", element });
    expect(recorder.stepCount).toBe(0);
    fakeTimer.advanceTime(MERGE_WINDOW_MS);
    expect(recorder.stepCount).toBe(4);
    const { steps } = await recorder.stop();
    expect(steps.map((step) => step.tool)).toEqual(["tapAt", "pressButton", "pinchOn", "sendKeys"]);
    expect(steps[3].params.commands[0].text).toBe("hello");
  });

  test("inputText does not coalesce across an unresolved gesture", async () => {
    await recorder.start();
    const element = { "resource-id": "com.example:id/search" };
    fakeA11y.emit({ type: "inputText", timestamp: 0, text: "hello", element });
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 10, screenY: 10 });
    fakeA11y.emit({ type: "inputText", timestamp: 0, text: "world", element });
    fakeA11y.emit({ type: "inputText", timestamp: 0, text: "world!", element });
    expect(recorder.stepCount).toBe(1);
    const { steps } = await recorder.stop();
    expect(steps.map((step) => step.tool)).toEqual(["sendKeys", "tapAt", "sendKeys"]);
    expect(steps[0].params.commands[0].text).toBe("hello");
    expect(steps[2].params.commands[0].text).toBe("world!");
  });

  test("a skipped gesture releases later resolved steps", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "swipe", arrivedAt: 0, startX: 10, startY: 10 });
    fakeGestures.emit({ type: "pressButton", arrivedAt: 0, button: "back" });
    expect(recorder.stepCount).toBe(0);
    fakeTimer.advanceTime(MERGE_WINDOW_MS);
    expect(recorder.stepCount).toBe(1);
    expect((await recorder.stop()).steps).toEqual([
      { tool: "pressButton", params: { button: "back" } },
    ]);
  });

  test("an unresolved doubleTap keeps the first tap's position and refreshes its deadline", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 891 });
    fakeTimer.advanceTime(100);
    fakeGestures.emit({ type: "pressButton", arrivedAt: 100, button: "back" });
    fakeGestures.emit({
      type: "doubleTap",
      arrivedAt: 100,
      firstTapArrivedAt: 0,
      screenX: 342,
      screenY: 891,
    });
    fakeTimer.advanceTime(MERGE_WINDOW_MS - 100);
    expect(recorder.stepCount).toBe(0);
    fakeTimer.advanceTime(50);
    fakeA11y.emit({ type: "tap", timestamp: 100, element: TAP_ELEMENT });
    expect(recorder.stepCount).toBe(2);
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapOn", params: { action: "doubleTap", elementId: TAP_ELEMENT["resource-id"] } },
      { tool: "pressButton", params: { button: "back" } },
    ]);
  });

  test("incoming stateChange after the touch beats an older buffered stateChange without consuming it", async () => {
    await recorder.start();
    const older = { ...TAP_ELEMENT, "resource-id": "com.example:id/older" };
    fakeTimer.advanceTime(90);
    fakeA11y.emit({ type: "stateChange", timestamp: 999999, element: older });
    fakeTimer.advanceTime(10);
    fakeGestures.emit({ type: "tap", arrivedAt: 100, screenX: 342, screenY: 891 });
    fakeTimer.advanceTime(50);
    fakeA11y.emit({ type: "stateChange", timestamp: -999999, element: TAP_ELEMENT });
    expect(recorder.stepCount).toBe(1);
    fakeTimer.advanceTime(50);
    fakeGestures.emit({ type: "tap", arrivedAt: 200, screenX: 342, screenY: 891 });
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } },
      { tool: "tapOn", params: { action: "tap", elementId: older["resource-id"] } },
    ]);
  });

  test.each([0, 50])(
    "the closest buffered stateChange at the touch beats an incoming event %d ms later",
    async (delay) => {
      await recorder.start();
      const older = { ...TAP_ELEMENT, "resource-id": "com.example:id/older" };
      fakeA11y.emit({ type: "stateChange", timestamp: 1000, element: older });
      fakeTimer.advanceTime(100);
      fakeA11y.emit({ type: "stateChange", timestamp: 1000, element: TAP_ELEMENT });
      fakeGestures.emit({ type: "tap", arrivedAt: 100, screenX: 342, screenY: 891 });
      fakeTimer.advanceTime(delay);
      fakeA11y.emit({ type: "stateChange", timestamp: 1000, element: older });
      expect((await recorder.stop()).steps).toEqual([
        { tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } },
      ]);
    },
  );

  test("buffered pre-touch stateChanges fall back to the closest receipt time", async () => {
    await recorder.start();
    fakeA11y.emit({
      type: "stateChange",
      timestamp: 1000,
      element: { ...TAP_ELEMENT, "resource-id": "com.example:id/older" },
    });
    fakeTimer.advanceTime(50);
    fakeA11y.emit({ type: "stateChange", timestamp: -1000, element: TAP_ELEMENT });
    fakeTimer.advanceTime(50);
    fakeGestures.emit({ type: "tap", arrivedAt: 100, screenX: 342, screenY: 891 });
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } },
    ]);
  });

  test("a buffered genuine tap takes precedence over stateChange candidates", async () => {
    await recorder.start();
    fakeA11y.emit({
      type: "stateChange",
      timestamp: 0,
      element: {
        ...TAP_ELEMENT,
        "resource-id": "com.example:id/state",
      },
    });
    fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 891 });
    fakeTimer.advanceTime(MERGE_WINDOW_MS);
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } },
    ]);
  });

  test.each(["longPress", "swipe"] as const)("stateChange does not match %s", async (type) => {
    await recorder.start();
    fakeGestures.emit({
      type,
      arrivedAt: 0,
      screenX: 342,
      screenY: 891,
      ...(type === "swipe" ? { startX: 342, startY: 891, direction: "up" as const } : {}),
    });
    fakeA11y.emit({ type: "stateChange", timestamp: 0, element: TAP_ELEMENT });
    expect(recorder.stepCount).toBe(0);
    const { steps } = await recorder.stop();
    expect(steps[0].tool).toBe(type === "swipe" ? "swipeOn" : "tapAt");
    expect(steps[0].params.elementId).toBeUndefined();
    expect(steps[0].params.container).toBeUndefined();
  });

  test("a late accessibility event cannot replace a timed-out tap or seed the next tap", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 891 });
    fakeTimer.advanceTime(MERGE_WINDOW_MS + 10);
    fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
    fakeTimer.advanceTime(10);
    fakeGestures.emit({ type: "tap", arrivedAt: fakeTimer.now(), screenX: 342, screenY: 891 });
    const { steps } = await recorder.stop();
    expect(steps).toEqual([
      { tool: "tapAt", params: { x: 342, y: 891, action: "tap" } },
      { tool: "tapAt", params: { x: 342, y: 891, action: "tap" } },
    ]);
  });

  test("unmatched swipe records direction and logs start coordinates", async () => {
    await recorder.start();
    const warning = spyOn(logger, "warn");
    try {
      fakeGestures.emit({
        type: "swipe",
        arrivedAt: 0,
        direction: "up",
        speed: "fast",
        startX: 500,
        startY: 800,
        endX: 500,
        endY: 200,
      });
      fakeTimer.advanceTime(MERGE_WINDOW_MS);
      expect((await recorder.stop()).steps).toEqual([
        { tool: "swipeOn", params: { direction: "up", speed: "fast" } },
      ]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("at (500, 800)"));
    } finally {
      warning.mockRestore();
    }
  });

  test("unmatched swipe without direction warns with start coordinates", async () => {
    await recorder.start();
    const warning = spyOn(logger, "warn");
    try {
      fakeGestures.emit({ type: "swipe", arrivedAt: 0, startX: 500, startY: 800 });
      expect((await recorder.stop()).steps).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("at (500, 800)"));
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("no swipe direction"));
    } finally {
      warning.mockRestore();
    }
  });

  test("matching bounds without a selector still preserve the touch", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 891 });
    fakeA11y.emit({ type: "tap", timestamp: 0, element: { bounds: TAP_ELEMENT.bounds } });
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapAt", params: { x: 342, y: 891, action: "tap" } },
    ]);
  });

  test("doubleTap upgrades an earlier coordinate fallback with delayed delivery", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 891 });
    fakeTimer.advanceTime(MERGE_WINDOW_MS);
    fakeGestures.emit({
      type: "doubleTap",
      arrivedAt: 150,
      firstTapArrivedAt: 0,
      screenX: 342,
      screenY: 891,
    });
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapAt", params: { x: 342, y: 891, action: "doubleTap" } },
    ]);
  });

  test.each([
    [400, 500],
    [12000, 10000],
  ])(
    "coordinate longPress duration %d is bounded to tapAt's contract (%d)",
    async (durationMs, expectedDuration) => {
      await recorder.start();
      fakeGestures.emit({
        type: "longPress",
        arrivedAt: 0,
        screenX: 342,
        screenY: 891,
        durationMs,
      });
      expect((await recorder.stop()).steps).toEqual([
        {
          tool: "tapAt",
          params: { x: 342, y: 891, action: "longPress", durationMs: expectedDuration },
        },
      ]);
    },
  );

  test("buffered stateChange outside the tap bounds cannot identify the tap", async () => {
    await recorder.start();
    fakeA11y.emit({ type: "stateChange", timestamp: 0, element: TAP_ELEMENT });
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 10, screenY: 10 });
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapAt", params: { x: 10, y: 10, action: "tap" } },
    ]);
  });

  test("an incoming genuine tap takes precedence over a buffered stateChange", async () => {
    await recorder.start();
    fakeA11y.emit({
      type: "stateChange",
      timestamp: 0,
      element: {
        ...TAP_ELEMENT,
        "resource-id": "com.example:id/state",
      },
    });
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 891 });
    fakeTimer.advanceTime(220);
    fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } },
    ]);
  });

  test("a buffered genuine tap takes precedence over an incoming stateChange", async () => {
    await recorder.start();
    fakeA11y.emit({ type: "tap", timestamp: 0, element: TAP_ELEMENT });
    fakeGestures.emit({ type: "tap", arrivedAt: 0, screenX: 342, screenY: 891 });
    fakeTimer.advanceTime(220);
    fakeA11y.emit({
      type: "stateChange",
      timestamp: 0,
      element: {
        ...TAP_ELEMENT,
        "resource-id": "com.example:id/state",
      },
    });
    expect((await recorder.stop()).steps).toEqual([
      { tool: "tapOn", params: { action: "tap", elementId: TAP_ELEMENT["resource-id"] } },
    ]);
  });

  test("tap gesture + matching A11y element → tapOn step", async () => {
    await recorder.start();

    fakeGestures.emit({ type: "tap", arrivedAt: fakeTimer.now(), screenX: 342, screenY: 891 });
    fakeA11y.emit({ type: "tap", timestamp: fakeTimer.now(), element: TAP_ELEMENT });

    const { steps } = await recorder.stop();

    expect(steps).toHaveLength(1);
    expect(steps[0].tool).toBe("tapOn");
    expect(steps[0].params.action).toBe("tap");
    expect(steps[0].params.elementId).toBe("com.example:id/login_btn");
  });

  test("doubleTap gesture + matching A11y element → tapOn doubleTap step", async () => {
    await recorder.start();

    fakeGestures.emit({
      type: "doubleTap",
      arrivedAt: fakeTimer.now(),
      screenX: 342,
      screenY: 891,
    });
    fakeA11y.emit({ type: "tap", timestamp: fakeTimer.now(), element: TAP_ELEMENT });

    const { steps } = await recorder.stop();

    expect(steps[0].tool).toBe("tapOn");
    expect(steps[0].params.action).toBe("doubleTap");
  });

  test("classifier double tap replaces an already matched tap with one CtrlProxy click", async () => {
    fakeTimer = new FakeTimer();
    recorder = new DualTrackRecorder(fakeDevice, fakeGestures, fakeA11y, fakeTimer);
    const classifier = new GestureClassifier({ toScreenPoint: (x, y) => ({ x, y }) }, 1);
    const emitFrame = (frame: RawTouchFrame) => {
      const gesture = classifier.feedFrame(frame);
      if (gesture) {
        fakeGestures.emit(gesture);
      }
    };
    await recorder.start();

    emitFrame(touchFrame(0, [{ slotId: 0, trackingId: 1, x: 500, y: 500 }]));
    fakeTimer.setCurrentTime(50);
    emitFrame(touchFrame(50, [], [0]));
    fakeA11y.emit({
      type: "tap",
      timestamp: 50,
      element: {
        "resource-id": "com.example:id/target",
        bounds: { left: 450, top: 450, right: 550, bottom: 550 },
      },
    });
    expect(recorder.stepCount).toBe(1);

    fakeTimer.setCurrentTime(100);
    emitFrame(touchFrame(100, [{ slotId: 0, trackingId: 2, x: 500, y: 500 }]));
    fakeTimer.setCurrentTime(150);
    emitFrame(touchFrame(150, [], [0]));
    fakeTimer.advanceTime(300);

    const { steps } = await recorder.stop();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      tool: "tapOn",
      params: { action: "doubleTap", elementId: "com.example:id/target" },
    });
  });

  test("doubleTap can use the pair's delayed only click while the first tap is pending", async () => {
    fakeTimer = new FakeTimer();
    recorder = new DualTrackRecorder(fakeDevice, fakeGestures, fakeA11y, fakeTimer);
    await recorder.start();

    fakeGestures.emit({ type: "tap", arrivedAt: 50, screenX: 500, screenY: 500 });
    fakeTimer.advanceTime(150);
    expect(recorder.stepCount).toBe(0);
    fakeGestures.emit({
      type: "doubleTap",
      arrivedAt: 150,
      firstTapArrivedAt: 50,
      screenX: 500,
      screenY: 500,
    });
    fakeTimer.advanceTime(360);
    fakeA11y.emit({
      type: "tap",
      timestamp: 150,
      element: {
        "resource-id": "com.example:id/target",
        bounds: { left: 450, top: 450, right: 550, bottom: 550 },
      },
    });
    const { steps } = await recorder.stop();
    expect(steps).toHaveLength(1);
    expect(steps[0].params.action).toBe("doubleTap");
  });

  test("longPress gesture + matching A11y element → tapOn longPress step", async () => {
    await recorder.start();

    fakeGestures.emit({
      type: "longPress",
      arrivedAt: fakeTimer.now(),
      screenX: 342,
      screenY: 891,
    });
    fakeA11y.emit({ type: "longPress", timestamp: fakeTimer.now(), element: TAP_ELEMENT });

    const { steps } = await recorder.stop();

    expect(steps[0].tool).toBe("tapOn");
    expect(steps[0].params.action).toBe("longPress");
  });

  test("swipe gesture + CtrlProxy scroll element → swipeOn step with direction", async () => {
    await recorder.start();

    fakeGestures.emit({
      type: "swipe",
      arrivedAt: fakeTimer.now(),
      direction: "up",
      startX: 500,
      startY: 800,
      endX: 500,
      endY: 200,
    });
    fakeA11y.emit({
      type: "scroll",
      timestamp: fakeTimer.now(),
      element: {
        "resource-id": "com.example:id/list",
        bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      },
      scrollDeltaX: 0,
      scrollDeltaY: 100,
    });

    const { steps } = await recorder.stop();

    expect(steps[0].tool).toBe("swipeOn");
    // getevent direction takes precedence over A11y scrollDelta
    expect(steps[0].params.direction).toBe("up");
  });

  test("pinch emits pinchOn immediately without waiting for A11y", async () => {
    await recorder.start();

    fakeGestures.emit({
      type: "pinch",
      arrivedAt: fakeTimer.now(),
      pinchDirection: "in",
      scale: 0.5,
    });

    expect(recorder.stepCount).toBe(1);
    const { steps } = await recorder.stop();

    expect(steps).toHaveLength(1);
    expect(steps[0].tool).toBe("pinchOn");
    expect(steps[0].params.direction).toBe("in");
    expect(steps[0].params.scale).toBe(0.5);
  });

  test("pressButton emits immediately without waiting for A11y", async () => {
    await recorder.start();

    fakeGestures.emit({ type: "pressButton", arrivedAt: fakeTimer.now(), button: "back" });

    expect(recorder.stepCount).toBe(1);
    const { steps } = await recorder.stop();

    expect(steps).toHaveLength(1);
    expect(steps[0].tool).toBe("pressButton");
    expect(steps[0].params.button).toBe("back");
  });

  test("inputText from A11y records a sendKeys replacement", async () => {
    await recorder.start();

    fakeA11y.emit({
      type: "inputText",
      timestamp: fakeTimer.now(),
      text: "hello@example.com",
      element: { "resource-id": "com.example:id/email_field" },
    });

    const { steps } = await recorder.stop();

    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      tool: "sendKeys",
      params: {
        commands: [
          {
            action: "type",
            text: "hello@example.com",
            operation: "replace",
          },
        ],
      },
    });
  });

  test.each(["disconnected", "rejected"])(
    "required connection %s still fails startup",
    async (mode) => {
      fakeA11y.connected = false;
      if (mode === "rejected") {
        fakeA11y.connectionError = new Error("connection failed");
      }
      await expect(recorder.start()).rejects.toThrow(
        mode === "rejected" ? "connection failed" : "Unable to connect",
      );
      expect(fakeGestures.startCount).toBe(0);
      expect(fakeA11y.subscriptionCount).toBe(0);
    },
  );

  test("consecutive inputText events on same element are coalesced", async () => {
    await recorder.start();

    const element = {
      "resource-id": "com.example:id/search",
      bounds: { left: 0, top: 0, right: 500, bottom: 60 },
    };
    fakeA11y.emit({ type: "inputText", timestamp: 100, text: "h", element });
    fakeA11y.emit({ type: "inputText", timestamp: 200, text: "he", element });
    fakeA11y.emit({ type: "inputText", timestamp: 300, text: "hel", element });

    const { steps } = await recorder.stop();
    // Should be coalesced into a single step with the last text
    expect(steps).toHaveLength(1);
    expect(steps[0].params.commands[0].text).toBe("hel");
  });

  test("buffered A11y event is rejected when gesture does not hit element bounds", async () => {
    await recorder.start();

    // A11y event arrives first (goes into buffer), then gesture arrives at a far-away coord
    fakeA11y.emit({ type: "tap", timestamp: fakeTimer.now(), element: TAP_ELEMENT });
    fakeGestures.emit({ type: "tap", arrivedAt: fakeTimer.now(), screenX: 10, screenY: 10 }); // far from TAP_ELEMENT bounds

    const { steps } = await recorder.stop();

    // The unrelated element must not replace the coordinate target.
    expect(steps).toEqual([{ tool: "tapAt", params: { x: 10, y: 10, action: "tap" } }]);
  });

  test("buffered A11y event older than 2×MERGE_WINDOW_MS is pruned and not matched", async () => {
    await recorder.start();

    // A11y event received at host time 0 (receivedAt = 0)
    fakeA11y.emit({ type: "tap", timestamp: fakeTimer.now(), element: TAP_ELEMENT });

    // Simulate time passing on the host — A11y event is now older than MAX_BUFFER_AGE_MS
    fakeTimer.setCurrentTime(MERGE_WINDOW_MS * 2 + 10);

    // Gesture arrives well after the A11y event was buffered
    fakeGestures.emit({ type: "tap", arrivedAt: fakeTimer.now(), screenX: 342, screenY: 891 });

    const { steps } = await recorder.stop();

    // The stale selector must not replace the coordinate target.
    expect(steps).toEqual([{ tool: "tapAt", params: { x: 342, y: 891, action: "tap" } }]);
  });

  test("stop flushes a tap with no matching A11y element as tapAt", async () => {
    await recorder.start();

    fakeGestures.emit({ type: "tap", arrivedAt: fakeTimer.now(), screenX: 50, screenY: 50 });
    // No A11y event emitted

    const { steps } = await recorder.stop();

    expect(steps).toEqual([{ tool: "tapAt", params: { x: 50, y: 50, action: "tap" } }]);
  });

  test("inputText coalescing skipped when intervening step exists", async () => {
    await recorder.start();

    const element = { "resource-id": "com.example:id/search" };
    fakeA11y.emit({ type: "inputText", timestamp: 100, text: "hello", element });
    // Intervening tap
    fakeGestures.emit({ type: "pressButton", arrivedAt: fakeTimer.now(), button: "back" });
    // Second edit on the same field — must NOT coalesce with first
    fakeA11y.emit({ type: "inputText", timestamp: 200, text: "world", element });

    const { steps } = await recorder.stop();
    expect(steps).toHaveLength(3);
    expect(steps[0].tool).toBe("sendKeys");
    expect(steps[0].params.commands[0].text).toBe("hello");
    expect(steps[1].tool).toBe("pressButton");
    expect(steps[2].tool).toBe("sendKeys");
    expect(steps[2].params.commands[0].text).toBe("world");
  });

  describe("emptied text field (#9929)", () => {
    const element = { "resource-id": "com.example:id/search" };
    const clearStep = { tool: "sendKeys", params: { commands: [{ action: "clear" }] } };

    test.each([null, ""])("text %p after typed text coalesces into a clear", async (empty) => {
      await recorder.start();

      fakeA11y.emit({ type: "inputText", timestamp: 100, text: "hello", element });
      fakeA11y.emit({ type: "inputText", timestamp: 200, text: empty, element });

      const { steps } = await recorder.stop();
      expect(steps).toEqual([clearStep]);
      expect(sendKeysSchema.safeParse(steps[0].params).success).toBe(true);
    });

    test.each([null, ""])("text %p as the first event records a clear", async (empty) => {
      await recorder.start();

      fakeA11y.emit({ type: "inputText", timestamp: 100, text: empty, element });

      const { steps } = await recorder.stop();
      expect(steps).toEqual([clearStep]);
      expect(sendKeysSchema.safeParse(steps[0].params).success).toBe(true);
    });

    test("a later non-empty value replaces the clear with a valid type step", async () => {
      await recorder.start();

      fakeA11y.emit({ type: "inputText", timestamp: 100, text: "hello", element });
      fakeA11y.emit({ type: "inputText", timestamp: 200, text: null, element });
      fakeA11y.emit({ type: "inputText", timestamp: 300, text: "world", element });

      const { steps } = await recorder.stop();
      expect(steps).toEqual([
        {
          tool: "sendKeys",
          params: { commands: [{ action: "type", text: "world", operation: "replace" }] },
        },
      ]);
      expect(sendKeysSchema.safeParse(steps[0].params).success).toBe(true);
    });

    test("an emptied field after an intervening step keeps the earlier typed text", async () => {
      await recorder.start();

      fakeA11y.emit({ type: "inputText", timestamp: 100, text: "hello", element });
      fakeGestures.emit({ type: "pressButton", arrivedAt: fakeTimer.now(), button: "back" });
      fakeA11y.emit({ type: "inputText", timestamp: 200, text: null, element });

      const { steps } = await recorder.stop();
      expect(steps).toHaveLength(3);
      expect(steps[0].params.commands[0].text).toBe("hello");
      expect(steps[2]).toEqual(clearStep);
    });

    test("an inputText event with no text value at all is still ignored", async () => {
      await recorder.start();

      fakeA11y.emit({ type: "inputText", timestamp: 100, element });

      const { steps } = await recorder.stop();
      expect(steps).toEqual([]);
    });
  });

  test("windowChange A11y events are not emitted as steps", async () => {
    await recorder.start();

    fakeA11y.emit({ type: "windowChange", timestamp: fakeTimer.now(), packageName: "com.example" });
    // Also add a real step to ensure we're tracking correctly
    fakeGestures.emit({ type: "pressButton", arrivedAt: fakeTimer.now(), button: "home" });

    const { steps } = await recorder.stop();

    expect(steps).toHaveLength(1);
    expect(steps[0].tool).toBe("pressButton");
  });

  test("multiple independent gestures produce multiple steps", async () => {
    await recorder.start();

    fakeGestures.emit({ type: "pressButton", arrivedAt: fakeTimer.now(), button: "back" });
    fakeGestures.emit({ type: "pressButton", arrivedAt: fakeTimer.now(), button: "home" });

    const { steps } = await recorder.stop();

    expect(steps).toHaveLength(2);
    expect(steps[0].params.button).toBe("back");
    expect(steps[1].params.button).toBe("home");
  });

  test("stopTestRecording returns correct step count", async () => {
    await recorder.start();
    fakeGestures.emit({ type: "pressButton", arrivedAt: fakeTimer.now(), button: "back" });
    const { stepCount } = await recorder.stop();
    expect(stepCount).toBe(1);
  });

  test("A11y event with text element using content-desc falls back to text selector", async () => {
    await recorder.start();

    fakeGestures.emit({ type: "tap", arrivedAt: fakeTimer.now(), screenX: 250, screenY: 400 });
    fakeA11y.emit({
      type: "tap",
      timestamp: fakeTimer.now(),
      element: {
        "content-desc": "Sign in",
        bounds: { left: 200, top: 380, right: 400, bottom: 420 },
      },
    });

    const { steps } = await recorder.stop();

    expect(steps[0].tool).toBe("tapOn");
    expect(steps[0].params.text).toBe("Sign in");
    expect(steps[0].params.elementId).toBeUndefined();
  });
});

describe("resolveSwipeDirection (scroll-delta axis mapping)", () => {
  // These deltas are accessibility SCROLL deltas (content movement), so the
  // mapping is deliberately inverted relative to GestureClassifier's finger
  // displacement: a positive scrollDeltaX (content moved right) is the user
  // swiping LEFT, and a positive scrollDeltaY (content moved down) is swiping UP.
  test.each([
    [0, 0, null, "no movement"],
    [10, 0, "left", "positive X delta inverts to left"],
    [-10, 0, "right", "negative X delta inverts to right"],
    [0, 10, "up", "positive Y delta inverts to up"],
    [0, -10, "down", "negative Y delta inverts to down"],
    [10, 5, "left", "dominant X axis wins"],
    [5, 10, "up", "dominant Y axis wins"],
    [10, 10, "left", "an axis tie resolves on the X branch"],
    [undefined, undefined, null, "absent deltas mean no direction"],
  ])("resolveSwipeDirection(%p, %p) → %p (%s)", (dx, dy, expected, _why) => {
    expect(resolveSwipeDirection(dx, dy)).toBe(expected);
  });
});

test("coordinate fallback without geometry records a legacy tap and warns", async () => {
  const emitter = new FakeGestureEmitter();
  const recorder = new DualTrackRecorder(
    fakeDevice,
    emitter,
    new FakeA11ySource(),
    new FakeTimer(),
  );
  const warning = spyOn(logger, "warn");
  try {
    await recorder.start();
    emitter.emit({ type: "tap", arrivedAt: 0, screenX: 123, screenY: 456 });
    const { steps } = await recorder.stop();
    expect(steps).toEqual([{ tool: "tapAt", params: { x: 123, y: 456, action: "tap" } }]);
    expect(steps[0]).not.toHaveProperty("geometry");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("recorded tapAt fallback"));
  } finally {
    warning.mockRestore();
  }
});

test("coordinate fallback carries the same native provenance as MCP recording", async () => {
  const emitter = new FakeGestureEmitter();
  const timer = new FakeTimer();
  const recorder = new DualTrackRecorder(fakeDevice, emitter, new FakeA11ySource(), timer);
  await recorder.start();
  emitter.emit({
    type: "tap",
    arrivedAt: 0,
    screenX: 123,
    screenY: 456,
    geometry: { platform: "android", deviceWidth: 1080, deviceHeight: 1920, orientation: 0 },
  });
  const { steps } = await recorder.stop();
  expect(steps).toEqual([
    {
      tool: "tapAt",
      params: { x: 123, y: 456, action: "tap" },
      geometry: {
        platform: "android",
        deviceWidth: 1080,
        deviceHeight: 1920,
        orientation: 0,
        x: 123,
        y: 456,
      },
    },
  ]);
});
