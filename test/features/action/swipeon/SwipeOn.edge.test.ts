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
  updatedAt: 0,
  observationId: "test-observation",
  display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
  screenSize: { width: 1000, height: 2000 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy: { hierarchy: { node: { $: { _id: "top" } } } },
});

describe("SwipeOn fromEdge (#12537)", () => {
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

  test("fromEdge left starts at the screen edge and swipes inward", async () => {
    const result = await createSwipeOn().execute({
      direction: "right",
      fromEdge: "left",
      autoTarget: false,
      at: 0.25,
      edgeInset: 6,
      includeSystemInsets: true,
    });
    expect(result.success).toBe(true);
    const call = gesture.getSwipeCalls()[0];
    expect([call.x1, call.y1, call.x2, call.y2]).toEqual([6, 500, 706, 500]);
  });

  test("fromEdge with a wrong-way direction fails without dispatch", async () => {
    const result = await createSwipeOn().execute({
      direction: "left",
      fromEdge: "left",
      autoTarget: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("must be");
    expect(gesture.getSwipeCalls()).toEqual([]);
  });
});
