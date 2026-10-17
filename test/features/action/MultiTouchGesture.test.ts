import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  MultiTouchGesture,
  type MultiTouchDispatchRequest,
} from "../../../src/features/action/MultiTouchGesture";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { observation } from "../../helpers/tapAtCoordinate";

const android: BootedDevice = { deviceId: "mt-android", platform: "android", name: "Android" };
const ios: BootedDevice = { deviceId: "mt-ios", platform: "ios", name: "iOS" };

function create(
  device: BootedDevice,
  respond: (request: MultiTouchDispatchRequest) => object = () => ({ success: true }),
) {
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation(1000, 2000));
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const requests: MultiTouchDispatchRequest[] = [];
  const client = async (request: MultiTouchDispatchRequest) => {
    requests.push(request);
    return respond(request) as { success: boolean };
  };
  let iosInvalidations = 0;
  const gesture = new MultiTouchGesture(device, new FakeAdbExecutor(), {
    timer,
    clients: { android: client, ios: client },
    invalidateIosCache: () => {
      iosInvalidations++;
    },
  });
  gesture.window = new FakeWindow();
  gesture.observeScreen = observeScreen;
  return { gesture, requests, iosInvalidations: () => iosInvalidations };
}

describe("MultiTouchGesture dispatch (#12535)", () => {
  test.each([android, ios])(
    "two-finger tap sends a stationary stroke on $platform",
    async (device) => {
      const { gesture, requests } = create(device);
      const result = await gesture.execute({ action: "tap", x: 500, y: 1000 });
      expect(result).toMatchObject({ success: true, action: "tap", fingers: 2, x1: 450, y1: 1000 });
      expect(requests).toHaveLength(1);
      expect(requests[0].plan).toMatchObject({
        fingers: 2,
        fingerSpacing: 100,
        durationMs: 50,
        points: [
          { x: 450, y: 1000 },
          { x: 550, y: 1000 },
        ],
        end: { x: 450, y: 1000 },
      });
    },
  );

  test.each([android, ios])(
    "two-finger long press holds for the duration on $platform",
    async (device) => {
      const { gesture, requests } = create(device);
      const result = await gesture.execute({
        action: "longPress",
        x: 500,
        y: 1000,
        durationMs: 1500,
      });
      expect(result).toMatchObject({ success: true, action: "longPress", duration: 1500 });
      expect(requests[0].plan.durationMs).toBe(1500);
      expect(requests[0].plan.end).toEqual(requests[0].plan.points[0]);
    },
  );

  test.each([android, ios])(
    "three-finger swipe up travels from the row on $platform",
    async (device) => {
      const { gesture, requests } = create(device);
      const result = await gesture.execute({
        action: "swipe",
        fingers: 3,
        direction: "up",
        x: 500,
        y: 1500,
        fingerSpacing: 100,
      });
      expect(result).toMatchObject({
        success: true,
        fingers: 3,
        x1: 400,
        y1: 1500,
        x2: 400,
        y2: 900,
      });
      expect(result.points).toEqual([
        { x: 400, y: 1500 },
        { x: 500, y: 1500 },
        { x: 600, y: 1500 },
      ]);
      expect(requests[0].plan.durationMs).toBe(300);
    },
  );

  test("normalized coordinates resolve against the screen", async () => {
    const { gesture, requests } = create(android);
    await gesture.execute({
      action: "tap",
      x: 0.5,
      y: 0.5,
      coordinateSpace: "normalized",
      fingers: 3,
    });
    expect(requests[0].plan.points[1]).toEqual({ x: 500, y: 1000 });
  });

  test("invalid options are refused before any dispatch", async () => {
    const { gesture, requests } = create(android);
    for (const fingers of [1, 6]) {
      const result = await gesture.execute({ action: "tap", x: 500, y: 1000, fingers });
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("fingers must be"),
      });
    }
    const outside = await gesture.execute({ action: "tap", x: 5000, y: 1000 });
    expect(outside.success).toBe(false);
    expect(requests).toEqual([]);
  });

  test("a missing device capability is reported as a refusal that dispatched nothing", async () => {
    const { gesture } = create(android, () => ({
      success: false,
      error: "multi_finger_gesture_v1 is not confirmed by the connected device service",
      unsupportedCapability: "multi_finger_gesture_v1",
    }));
    const result = await gesture.execute({ action: "tap", x: 500, y: 1000, fingers: 4 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("multi_finger_gesture_v1");
    expect(result.error).toContain("does not advertise multi-finger gestures");
    expect(result.error).toContain("Two-finger gestures (fingers: 2) still work");
    expect(result.error).toContain("AUTOMOBILE_CTRL_PROXY_APK_PATH");
    expect(result.error).toContain("upgrade AutoMobile");
    expect(result.error).toContain("Nothing was dispatched");
    expect(result.outcomeIndeterminate).toBeUndefined();
  });

  test("a dispatched request with a lost reply is indeterminate and not retryable", async () => {
    const { gesture } = create(ios, (request) => {
      request.onDispatch();
      return { success: false, error: "timed out", dispatched: true, acknowledged: false };
    });
    const result = await gesture.execute({ action: "tap", x: 500, y: 1000 });
    expect(result).toMatchObject({ success: false, outcomeIndeterminate: true, retryable: false });
  });

  test("iOS invalidates the hierarchy cache after delivery; Android does not", async () => {
    const iosRun = create(ios);
    await iosRun.gesture.execute({ action: "tap", x: 500, y: 1000 });
    expect(iosRun.iosInvalidations()).toBe(1);
    const androidRun = create(android);
    await androidRun.gesture.execute({ action: "tap", x: 500, y: 1000 });
    expect(androidRun.iosInvalidations()).toBe(0);
  });
});
