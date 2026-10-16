import { beforeEach, describe, expect, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon";
import type { ObserveResult } from "../../../../src/models";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../../fakes/FakeAwaitIdle";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { FakeTimer } from "../../../fakes/FakeTimer";

const device = { name: "test-device", platform: "android", deviceId: "device-1" } as const;

const observation = (): ObserveResult => ({
  timestamp: 0,
  screenSize: { width: 1000, height: 2000 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy: { hierarchy: { node: { $: { _id: "top" } } } },
});

describe("SwipeOn durationMs (#12538)", () => {
  let gesture: FakeGestureExecutor;
  let observe: FakeObserveScreen;

  const createSwipeOn = () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const swipeOn = new SwipeOn(device, new FakeAdbExecutor(), {
      executeGesture: gesture,
      observeScreen: observe,
      accessibilityDetector: new FakeAccessibilityDetector(),
    });
    const window = new FakeWindow();
    window.configureCachedActiveWindow(null);
    Object.assign(swipeOn, { awaitIdle: new FakeAwaitIdle(), window, timer });
    return swipeOn;
  };

  beforeEach(() => {
    gesture = new FakeGestureExecutor();
    observe = new FakeObserveScreen();
    observe.setObserveResult(observation());
  });

  test("durationMs is the dispatched stroke duration and is reported", async () => {
    const result = await createSwipeOn().execute({
      direction: "up",
      autoTarget: false,
      durationMs: 120,
    });
    expect(result.success).toBe(true);
    expect(gesture.getSwipeCalls()[0].options?.duration).toBe(120);
  });

  test("speed and durationMs together are rejected before dispatch", async () => {
    const result = await createSwipeOn().execute({
      direction: "up",
      autoTarget: false,
      durationMs: 120,
      speed: "fast",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("durationMs cannot be combined with speed");
    expect(gesture.getSwipeCalls()).toEqual([]);
  });

  test("out-of-range durationMs is rejected before dispatch", async () => {
    for (const durationMs of [0, 3001, 1.5]) {
      const result = await createSwipeOn().execute({
        direction: "up",
        autoTarget: false,
        durationMs,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("durationMs must be an integer");
    }
    expect(gesture.getSwipeCalls()).toEqual([]);
  });
});
