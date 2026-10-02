import { describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import type { BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { clearCtrlProxyRegistries } from "./ctrlProxyRegistryCleanup";

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

describe("CtrlProxy unit-test preload registry cleanup", () => {
  // Exercise the exact hook function without relying on other files' order.
  test("Android cleanup clears a registered client", () => {
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
    clearCtrlProxyRegistries();
    expect(AndroidCtrlProxyClient.getExistingInstance(androidDevice.deviceId)).toBeNull();
  });

  test("iOS cleanup clears a registered client", () => {
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
    clearCtrlProxyRegistries();
    expect(IOSCtrlProxyClient.getExistingInstance(iosDevice.deviceId)).toBeNull();
  });
});
