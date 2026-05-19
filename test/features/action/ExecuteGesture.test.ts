import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import type { BootedDevice } from "../../../src/models";

describe("ExecuteGesture", () => {
  const androidDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device"
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
        gestureTimeMs: 1
      })
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
});
