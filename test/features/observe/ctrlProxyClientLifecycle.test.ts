import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ctrlProxyClientLifecycle } from "../../../src/features/observe/ctrlProxyClientLifecycle";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios/IOSCtrlProxyClient";

describe("ctrlProxyClientLifecycle", () => {
  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
  });

  test("resume dispatches to exactly the device's platform", () => {
    const android = spyOn(AndroidCtrlProxyClient, "resumeAfterDeviceStart").mockImplementation(
      () => {},
    );
    const ios = spyOn(IOSCtrlProxyClient, "resumeAfterDeviceStart").mockImplementation(() => {});
    try {
      ctrlProxyClientLifecycle.resumeAfterDeviceStart("android", "emulator-5554");
      expect(android.mock.calls).toEqual([["emulator-5554"]]);
      expect(ios.mock.calls).toEqual([]);

      ctrlProxyClientLifecycle.resumeAfterDeviceStart("ios", "SIM-1");
      expect(android.mock.calls).toHaveLength(1);
      expect(ios.mock.calls).toEqual([["SIM-1"]]);
    } finally {
      android.mockRestore();
      ios.mockRestore();
    }
  });

  test("retire dispatches per platform and awaits the iOS fence", async () => {
    const android = spyOn(AndroidCtrlProxyClient, "retireForShutdown").mockImplementation(() => {});
    let iosFenced = false;
    const ios = spyOn(IOSCtrlProxyClient, "retireInstance").mockImplementation(async () => {
      await Promise.resolve();
      iosFenced = true;
    });
    try {
      await ctrlProxyClientLifecycle.retireForShutdown("android", "emulator-5554");
      expect(android.mock.calls).toEqual([["emulator-5554"]]);
      expect(ios.mock.calls).toEqual([]);

      await ctrlProxyClientLifecycle.retireForShutdown("ios", "SIM-1");
      expect(iosFenced).toBe(true);
      expect(ios.mock.calls).toEqual([["SIM-1"]]);
    } finally {
      android.mockRestore();
      ios.mockRestore();
    }
  });
});
