import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import type { BootedDevice } from "../../../../src/models";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";

const DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel_9_Pro",
  platform: "android",
};

describe("AndroidCtrlProxyClient incarnation invalidation", () => {
  beforeEach(() => {
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
  });

  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
  });

  test("does not evict a replacement client when concurrent restores finish out of order", async () => {
    const oldClient = AndroidCtrlProxyClient.getInstance(DEVICE, new FakeAdbClientFactory());
    let resolveFirstClose: (() => void) | undefined;
    let resolveSecondClose: (() => void) | undefined;
    const firstClose = new Promise<void>((resolve) => {
      resolveFirstClose = resolve;
    });
    const secondClose = new Promise<void>((resolve) => {
      resolveSecondClose = resolve;
    });
    let closeCalls = 0;
    (oldClient as unknown as { close(): Promise<void> }).close = async () => {
      closeCalls++;
      await (closeCalls === 1 ? firstClose : secondClose);
    };

    const firstRestore = AndroidCtrlProxyClient.invalidateForDeviceIncarnation(DEVICE.deviceId);
    const secondRestore = AndroidCtrlProxyClient.invalidateForDeviceIncarnation(DEVICE.deviceId);
    resolveFirstClose?.();
    await firstRestore;

    const replacement = AndroidCtrlProxyClient.getInstance(DEVICE, new FakeAdbClientFactory());
    resolveSecondClose?.();
    await secondRestore;

    expect(AndroidCtrlProxyClient.getExistingInstance(DEVICE.deviceId)).toBe(replacement);
  });
});
