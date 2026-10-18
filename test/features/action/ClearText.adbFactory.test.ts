import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ClearText } from "../../../src/features/action/ClearText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice, ObserveResult } from "../../../src/models";

describe("ClearText accessibility-service path", () => {
  const device: BootedDevice = { name: "device-1", platform: "android", deviceId: "device-1" };
  let originalGetInstance: typeof AndroidCtrlProxyClient.getInstance;

  beforeEach(() => {
    originalGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.resetInstances();
  });

  afterEach(() => {
    AndroidCtrlProxyClient.getInstance = originalGetInstance;
    AndroidCtrlProxyClient.resetInstances();
  });

  test("regression #2226: passes AdbClientFactory (not AdbExecutor) to AndroidCtrlProxyClient.getInstance", async () => {
    const fakeFactory = new FakeAdbClientFactory();
    const capturedArgs: unknown[] = [];

    AndroidCtrlProxyClient.getInstance = (dev: BootedDevice, adbFactory?: AdbClientFactory) => {
      capturedArgs.push(adbFactory);
      const client = originalGetInstance(dev, adbFactory);
      spyOn(client, "requestClearText").mockResolvedValue({ success: true, totalTimeMs: 50 });
      return client;
    };

    const clearText = new ClearText(device, fakeFactory);
    capturedArgs.length = 0; // ignore construction-time calls; only assert about the a11y path
    const result = await clearText["executeAndroidClearText"]({} as ObserveResult);

    expect(result.success).toBe(true);
    expect(capturedArgs.length).toBe(1);

    const passed = capturedArgs[0] as { create?: (d: BootedDevice) => unknown };
    expect(typeof passed.create).toBe("function");
    // Calling create() on the factory must not throw (this is what AndroidCtrlProxyClient.getInstance does
    // on cache-miss). The bug was passing an AdbExecutor here, which has no .create method.
    expect(() => passed.create!(device)).not.toThrow();
  });
});
