import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import type { BootedDevice } from "../../../src/models";

describe("ExecuteGesture", () => {
  const androidDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };
  const iosDevice: BootedDevice = {
    deviceId: "ios-test-device",
    platform: "ios",
    name: "Test iPhone",
  };

  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    getInstanceSpy = null;
  });

  // Regression for https://github.com/kaeawc/auto-mobile/issues/2225.
  // executeA11ySwipe called AndroidCtrlProxyClient.getInstance(device, this.adb),
  // but getInstance expects an AdbClientFactory and immediately invokes
  // `.create(device)`. After bundler minification this surfaced as
  // `TypeError: <minified>.create is not a function` and crashed every
  // a11y-mode gesture on a fresh device.
  test("passes the AdbClientFactory (not AdbExecutor) to AndroidCtrlProxyClient.getInstance in a11y mode (regression for #2225)", async () => {
    const factory = new FakeAdbClientFactory();
    const fakeClient = {
      requestSwipe: async () => ({
        success: true,
        totalTimeMs: 1,
        gestureTimeMs: 1,
      }),
    } as unknown as AndroidCtrlProxyClient;

    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(fakeClient);

    const gesture = new ExecuteGesture(androidDevice, factory as any);
    const result = await gesture.swipe(0, 0, 100, 100, { scrollMode: "a11y" });

    expect(result.success).toBe(true);
    expect(getInstanceSpy).toHaveBeenCalled();
    const passed = getInstanceSpy!.mock.calls[0][1] as { create?: unknown };
    expect(typeof passed).toBe("object");
    expect(typeof passed.create).toBe("function");
  });

  test("delegates iOS multi-finger FingerPath gestures to CtrlProxy with supplied spacing", async () => {
    const fakeClient = new FakeIOSCtrlProxy();
    getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeClient as unknown as IOSCtrlProxyClient,
    );

    const gesture = new ExecuteGesture(iosDevice, null);
    const result = await gesture.execute(
      [
        {
          finger: 0,
          points: [
            { x: 100, y: 600 },
            { x: 100, y: 200 },
          ],
        },
        {
          finger: 1,
          points: [
            { x: 130.5, y: 600 },
            { x: 130.5, y: 200 },
          ],
        },
      ],
      450,
    );

    expect(result).toEqual({ pathLength: 2, duration: 450, platform: "ios" });
    expect(fakeClient.getMultiFingerSwipeHistory()).toEqual([
      {
        x1: 100,
        y1: 600,
        x2: 100,
        y2: 200,
        fingerCount: 2,
        duration: 450,
        fingerSpacing: 30.5,
      },
    ]);
  });

  test("propagates failed iOS multi-finger swipe results", async () => {
    const fakeClient = new FakeIOSCtrlProxy();
    fakeClient.setMultiFingerSwipeResult({
      success: false,
      error: "XCTest private multi-touch event synthesis classes are unavailable",
      totalTimeMs: 1,
    });
    getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeClient as unknown as IOSCtrlProxyClient,
    );

    const gesture = new ExecuteGesture(iosDevice, null);

    await expect(
      gesture.execute(
        [
          {
            finger: 0,
            points: [
              { x: 100, y: 600 },
              { x: 100, y: 200 },
            ],
          },
          {
            finger: 1,
            points: [
              { x: 125, y: 600 },
              { x: 125, y: 200 },
            ],
          },
        ],
        300,
      ),
    ).rejects.toThrow(
      "iOS multi-finger gesture failed: XCTest private multi-touch event synthesis classes are unavailable",
    );
  });

  test("rejects iOS multi-finger paths CtrlProxy cannot preserve", async () => {
    const fakeClient = new FakeIOSCtrlProxy();
    getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeClient as unknown as IOSCtrlProxyClient,
    );

    const gesture = new ExecuteGesture(iosDevice, null);

    await expect(
      gesture.execute(
        [
          {
            finger: 0,
            points: [
              { x: 100, y: 600 },
              { x: 100, y: 200 },
            ],
          },
          {
            finger: 1,
            points: [
              { x: 100, y: 630 },
              { x: 100, y: 230 },
            ],
          },
        ],
        300,
      ),
    ).rejects.toThrow("iOS multi-finger gestures only support horizontally spaced parallel swipes");
    expect(fakeClient.getMultiFingerSwipeHistory()).toHaveLength(0);
  });

  test("rejects under-specified iOS multi-finger paths", async () => {
    const fakeClient = new FakeIOSCtrlProxy();
    getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeClient as unknown as IOSCtrlProxyClient,
    );

    const gesture = new ExecuteGesture(iosDevice, null);

    await expect(
      gesture.execute(
        [
          {
            finger: 0,
            points: [{ x: 100, y: 600 }],
          },
          {
            finger: 1,
            points: [
              { x: 130, y: 600 },
              { x: 130, y: 200 },
            ],
          },
        ],
        300,
      ),
    ).rejects.toThrow("iOS multi-finger gestures require at least two points per finger");
    expect(fakeClient.getMultiFingerSwipeHistory()).toHaveLength(0);
  });
});
