import { describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import type { BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

const androidDevice: BootedDevice = {
  deviceId: "preload-reset-android",
  platform: "android",
  isEmulator: true,
  name: "Fake Android",
};

const iosDevice: BootedDevice = {
  deviceId: "PRELOAD-RESET-IOS",
  platform: "ios",
  name: "Fake iPhone",
};

describe.serial("CtrlProxy unit-test preload registry cleanup", () => {
  // These registration/absence pairs intentionally depend on declaration order:
  // the preload's afterEach must clear A's client before B runs.
  test("Android client is registered in the current test", () => {
    const timer = new FakeTimer();
    const client = AndroidCtrlProxyClient.createForTesting(
      androidDevice,
      new FakeAdbExecutor(),
      () => {
        throw new Error("Registry test must not open a WebSocket");
      },
      timer,
    );

    AndroidCtrlProxyClient.registerForTesting(client, androidDevice.deviceId);
    expect(AndroidCtrlProxyClient.getExistingInstance(androidDevice.deviceId)).toBe(client);
  });

  test("Android client registered by the prior test was cleared", () => {
    expect(AndroidCtrlProxyClient.getExistingInstance(androidDevice.deviceId)).toBeNull();
  });

  test("iOS client is registered in the current test", () => {
    const timer = new FakeTimer();
    const client = IOSCtrlProxyClient.createForTesting(
      iosDevice,
      8765,
      () => {
        throw new Error("Registry test must not open a WebSocket");
      },
      timer,
    );

    IOSCtrlProxyClient.registerForTesting(client, iosDevice.deviceId);
    expect(IOSCtrlProxyClient.getExistingInstance(iosDevice.deviceId)).toBe(client);
  });

  test("iOS client registered by the prior test was cleared", () => {
    expect(IOSCtrlProxyClient.getExistingInstance(iosDevice.deviceId)).toBeNull();
  });
});
