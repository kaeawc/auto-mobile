import { describe, expect, test } from "bun:test";
import { SwipeOnElement } from "../../../src/features/action/SwipeOnElement";
import type { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import type { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import type { BootedDevice, Element, ObserveResult, SwipeResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeElementGeometry } from "../../fakes/FakeElementGeometry";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { platform: "android", deviceId: "fake-swipe", name: "Fake" };
const element: Element = { bounds: { left: 0, top: 0, right: 400, bottom: 800 } };
const observation: ObserveResult = {
  updatedAt: 0,
  screenSize: { width: 400, height: 800 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
};

class RecordingGesture implements Pick<ExecuteGesture, "swipe"> {
  readonly calls: Parameters<ExecuteGesture["swipe"]>[] = [];
  readonly result: SwipeResult = {
    success: true,
    x1: 200,
    y1: 700,
    x2: 200,
    y2: 200,
    duration: 300,
  };

  async swipe(...args: Parameters<ExecuteGesture["swipe"]>): Promise<SwipeResult> {
    this.calls.push(args);
    return this.result;
  }
}

class TestSwipeOnElement extends SwipeOnElement {
  constructor(gesture: RecordingGesture, geometry: FakeElementGeometry) {
    super(device, new FakeAdbExecutor(), geometry, gesture);
    this.timer = new FakeTimer();
  }

  // Exercise the action callback directly, as in the TapOnElement tests. This
  // isolates its dispatch boundary from BaseVisualChange's own abort checks and
  // avoids real observation, device commands, and timers.
  override async observedInteraction(
    action: Parameters<BaseVisualChange["observedInteraction"]>[0],
  ): Promise<SwipeResult> {
    return action(observation);
  }
}

describe("SwipeOnElement", () => {
  test("forwards the cancellation signal to the injected swipe dispatch", async () => {
    const gesture = new RecordingGesture();
    const geometry = new FakeElementGeometry();
    geometry.swipeResult = { startX: 200.9, startY: 700.8, endX: 200.7, endY: 200.6 };
    const swipe = new TestSwipeOnElement(gesture, geometry);
    const controller = new AbortController();
    const options = { duration: 300 };

    const result = await swipe.execute(element, "up", options, undefined, controller.signal);

    expect(gesture.calls).toHaveLength(1);
    expect(gesture.calls[0]?.slice(0, 5)).toEqual([200, 700, 200, 200, options]);
    expect(gesture.calls[0]?.[6]).toBe(controller.signal);
    expect(result).toBe(gesture.result);
  });

  test("rejects an already aborted signal before computing or dispatching a swipe", async () => {
    const gesture = new RecordingGesture();
    const geometry = new FakeElementGeometry();
    let geometryCalls = 0;
    geometry.getSwipeWithinBounds = () => {
      geometryCalls++;
      return geometry.swipeResult;
    };
    const swipe = new TestSwipeOnElement(gesture, geometry);

    await expect(swipe.execute(element, "up", {}, undefined, AbortSignal.abort())).rejects.toThrow(
      "Operation cancelled",
    );

    expect(geometryCalls).toBe(0);
    expect(gesture.calls).toEqual([]);
  });

  test("dispatches and returns the existing swipe result without a signal", async () => {
    const gesture = new RecordingGesture();
    const swipe = new TestSwipeOnElement(gesture, new FakeElementGeometry());

    expect(await swipe.execute(element, "up")).toBe(gesture.result);
    expect(gesture.calls).toHaveLength(1);
    expect(gesture.calls[0]?.slice(0, 5)).toEqual([200, 700, 200, 200, {}]);
    expect(gesture.calls[0]?.[6]).toBeUndefined();
  });
});
