import { describe, expect, mock, test } from "bun:test";
import type { AndroidCtrlProxy } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { BootedDevice } from "../../../src/models/DeviceInfo";
import { DeviceReadiness } from "../../../src/daemon/readiness/DeviceReadiness";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeDeviceClientProvider } from "../../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { getAbortSignal } from "../../../src/utils/AbortContext";

const androidDevice: BootedDevice = {
  name: "Pixel_API_35",
  deviceId: "emulator-5554",
  platform: "android",
};

describe("DeviceReadiness session broker ports", () => {
  test("lists booted Android devices with a fresh inventory and caller signal", async () => {
    const adb = new FakeAdbExecutor();
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("android", [androidDevice]);
    const readiness = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(adb, deviceUtils),
    );
    const controller = new AbortController();

    await expect(
      readiness.listBootedAndroidDevices({
        signal: controller.signal,
        androidTargetDeviceId: androidDevice.deviceId,
        skipAndroidProfileEnrichment: true,
      }),
    ).resolves.toEqual([androidDevice]);
    expect(deviceUtils.getBootedDevicesDetailedCalls()).toEqual([
      {
        platform: "android",
        options: {
          bypassAndroidDeviceListCache: true,
          signal: controller.signal,
          androidTargetDeviceId: androidDevice.deviceId,
          skipAndroidProfileEnrichment: true,
        },
      },
    ]);
  });

  test("verifies Android CtrlProxy readiness with the established retry budget", async () => {
    const adb = new FakeAdbExecutor();
    const deviceUtils = new FakeDeviceUtils();
    const verifyServiceReady = mock(async () => true);
    const ctrlProxy = Object.assign(new FakeCtrlProxy(), { verifyServiceReady });
    const readiness = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(adb, deviceUtils, undefined, {
        ctrlProxyClient: ctrlProxy as AndroidCtrlProxy,
      }),
    );

    await expect(readiness.verifyAndroidCtrlProxyServiceReady(androidDevice)).resolves.toBe(true);
    expect(verifyServiceReady).toHaveBeenCalledWith(2, 200, 2000);
  });

  test("broker health probes use one attempt, the caller timeout and its cancellation signal", async () => {
    const adb = new FakeAdbExecutor();
    const deviceUtils = new FakeDeviceUtils();
    let probeSignal: AbortSignal | undefined;
    const verifyServiceReady = mock(async () => {
      probeSignal = getAbortSignal();
      probeSignal?.throwIfAborted();
      return true;
    });
    const ctrlProxy = Object.assign(new FakeCtrlProxy(), { verifyServiceReady });
    const readiness = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(adb, deviceUtils, undefined, {
        ctrlProxyClient: ctrlProxy as AndroidCtrlProxy,
      }),
    );
    const controller = new AbortController();
    await expect(
      readiness.verifyAndroidCtrlProxyServiceReady(androidDevice, {
        signal: controller.signal,
        timeoutMs: 847,
        noRetry: true,
      }),
    ).resolves.toBe(true);
    expect(verifyServiceReady).toHaveBeenCalledWith(1, 200, 847);
    expect(probeSignal).toBe(controller.signal);
    controller.abort(new Error("health cancelled"));
    await expect(
      readiness.verifyAndroidCtrlProxyServiceReady(androidDevice, {
        signal: controller.signal,
        timeoutMs: 847,
        noRetry: true,
      }),
    ).rejects.toThrow("health cancelled");
  });
});
