import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../../src/models";
import { ActionableError } from "../../../../src/models/ActionableError";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { assertAndroidCtrlProxyDevice } from "../../../../src/features/observe/android/androidCtrlProxyDeviceGuard";
import { androidCtrlProxyClientForPlatform } from "../../../../src/features/observe/android/androidCtrlProxyClientFor";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";

const simulatorId = "8935BFAD-F01F-40FF-95E0-83FD0FF63DEB";
const invalidDevices: BootedDevice[] = [
  { deviceId: simulatorId, platform: "ios", name: "iPhone" },
  ...[simulatorId, "00008030-001C2D3E1234567A", "a".repeat(40)].map((deviceId) => ({
    deviceId,
    platform: "android" as const,
    name: "misclassified Apple device",
  })),
];

beforeEach(() => AndroidCtrlProxyClient.clearInstanceRegistryForTesting());
afterEach(() => AndroidCtrlProxyClient.clearInstanceRegistryForTesting());

describe("Android CtrlProxy platform guard", () => {
  test.each(invalidDevices)("refuses and warns for $platform $deviceId", (device) => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(() => assertAndroidCtrlProxyDevice(device)).toThrow(ActionableError);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0];
      expect(message).toContain(
        "[CTRL_PROXY] Refusing to register an Android CtrlProxy client for",
      );
      expect(message).toContain(device.deviceId);
      expect(message).toContain(device.platform);
      expect(message).toContain(device.platform === "ios" ? "platform is not android" : "iOS UDID");
    } finally {
      warn.mockRestore();
    }
  });

  test.each(["emulator-5554", "R5CT123ABCD"])("accepts Android %s", (deviceId) => {
    expect(() =>
      assertAndroidCtrlProxyDevice({ deviceId, platform: "android", name: "Android" }),
    ).not.toThrow();
  });

  for (const resolve of [
    AndroidCtrlProxyClient.getInstance,
    AndroidCtrlProxyClient.createForObservationRead,
  ]) {
    test.each(invalidDevices)(
      `${resolve.name} refuses before factory or registry access: $deviceId $platform`,
      (device) => {
        const factory = new FakeAdbClientFactory();
        expect(() => resolve(device, factory)).toThrow(ActionableError);
        expect(factory.getCallCount()).toBe(0);
        expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
      },
    );
  }

  test("platform helper preserves eager Android singleton resolution", () => {
    const factory = new FakeAdbClientFactory();
    const device: BootedDevice = {
      deviceId: "emulator-5554",
      platform: "android",
      name: "Android",
    };
    const client = androidCtrlProxyClientForPlatform(device, factory);
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId) === client).toBe(true);
    expect(client).toBe(AndroidCtrlProxyClient.getInstance(device, factory));
    expect(factory.getCallCount()).toBe(1);
  });

  test("platform helper refuses only when the non-Android stand-in is used", () => {
    const factory = new FakeAdbClientFactory();
    const device = invalidDevices[0]!;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const client = androidCtrlProxyClientForPlatform(device, factory);
      expect(warn).not.toHaveBeenCalled();
      expect(Reflect.get(client, "then")).toBeUndefined();
      expect(Reflect.get(client, Symbol.toStringTag)).toBeUndefined();
      expect(() => client.ensureConnected).toThrow(ActionableError);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(factory.getCallCount()).toBe(0);
      expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
