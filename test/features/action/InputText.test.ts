import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InputText } from "../../../src/features/action/InputText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import type { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";

describe("InputText", () => {
  const androidDevice: BootedDevice = {
    deviceId: "input-text-device",
    platform: "android",
    name: "Test Device",
  };

  let originalGetInstance: typeof AndroidCtrlProxyClient.getInstance;

  beforeEach(() => {
    originalGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.resetInstances();
  });

  afterEach(() => {
    AndroidCtrlProxyClient.getInstance = originalGetInstance;
    AndroidCtrlProxyClient.resetInstances();
  });

  // Regression for https://github.com/kaeawc/auto-mobile/issues/2229.
  // executeAndroidTextInput calls AndroidCtrlProxyClient.getInstance, which
  // invokes `.create(device)` on its second argument. Passing the AdbExecutor
  // (this.adb) instead of the AdbClientFactory (this.adbFactory) surfaces in
  // production as `TypeError: <minified>.create is not a function` on the
  // first ctrl-proxy call per device. Asserts the factory is forwarded.
  test("forwards adbFactory (not adb executor) to AndroidCtrlProxyClient.getInstance (regression for #2229)", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);

    let capturedFactory: unknown = undefined;
    AndroidCtrlProxyClient.getInstance = ((device: BootedDevice, adbFactory: AdbClientFactory) => {
      capturedFactory = adbFactory;
      return originalGetInstance(device, adbFactory);
    }) as typeof AndroidCtrlProxyClient.getInstance;

    try {
      await (inputText as unknown as {
        executeAndroidTextInput: (text: string) => Promise<unknown>;
      }).executeAndroidTextInput("hello");
    } catch {
      // Ignore downstream failures — we only care that getInstance was
      // handed a factory, not an executor.
    }

    expect(capturedFactory).toBeDefined();
    expect(typeof (capturedFactory as AdbClientFactory).create).toBe("function");
    expect(capturedFactory).toBe(factory as unknown as AdbClientFactory);
  });
});
