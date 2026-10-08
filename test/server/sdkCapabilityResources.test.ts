import { afterEach, describe, expect, test } from "bun:test";
import {
  registerSdkCapabilityResources,
  type SdkCapabilityResourceDependencies,
} from "../../src/server/sdkCapabilityResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { BootedDevice } from "../../src/models";
import type {
  SdkCapabilitiesReader,
  SdkCapabilitiesResult,
} from "../../src/features/sdk/sdkCapabilities";

class FakeSdkCapabilitiesReader implements SdkCapabilitiesReader {
  readonly calls: string[] = [];
  readonly userIds: (number | undefined)[] = [];
  failure?: Error;
  result: SdkCapabilitiesResult = {
    status: "available",
    snapshot: {
      schemaVersion: 1,
      capabilities: [{ id: "network.control", state: "SUPPORTED" }],
      policy: { captureHeaders: false, captureBodies: false, allowMutations: false },
    },
  };
  async getSdkCapabilities(packageName: string, userId?: number): Promise<SdkCapabilitiesResult> {
    this.calls.push(packageName);
    this.userIds.push(userId);
    if (this.failure) {
      throw this.failure;
    }
    return this.result;
  }
}

describe("sdkCapabilityResources", () => {
  const android: BootedDevice = { name: "Pixel_7", platform: "android", deviceId: "emulator-5554" };
  const ios: BootedDevice = {
    name: "iPhone",
    platform: "ios",
    deviceId: "00008110-000A1B2C3D4E5F60",
  };

  afterEach(() => {
    PlatformDeviceManagerFactory.setInstance(null);
    ResourceRegistry.clearResources();
  });

  // A fake ADB with no foreground app by default, so no test reaches a real device.
  function setup(devices: BootedDevice[], dependencies: SdkCapabilityResourceDependencies) {
    PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager([], devices));
    registerSdkCapabilityResources({
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      ...dependencies,
    });
  }

  function foregroundAdb(packageName: string, userId: number) {
    const adb = new FakeAdbExecutor();
    adb.setForegroundApp({ packageName, userId });
    return new FakeAdbClientFactory(adb);
  }

  async function read(uri: string) {
    const match = ResourceRegistry.matchTemplate(uri);
    if (!match) {
      throw new Error(`no template matched: ${uri}`);
    }
    return JSON.parse((await match.template.handler(match.params)).text ?? "{}");
  }

  test("matches both the bare and app-scoped URI", () => {
    setup([android], {});
    for (const uri of [
      "automobile:devices/emulator-5554/sdk/capabilities",
      "automobile:devices/emulator-5554/sdk/capabilities?appId=com.example",
    ]) {
      expect(ResourceRegistry.matchTemplate(uri)?.template.uriTemplate).toBe(
        "automobile:devices/{deviceId}/sdk/capabilities{?appId}",
      );
    }
  });

  test("returns the snapshot for an explicit app id", async () => {
    const reader = new FakeSdkCapabilitiesReader();
    setup([android], { createReader: () => reader });
    const body = await read("automobile:devices/emulator-5554/sdk/capabilities?appId=com.example");
    expect(reader.calls).toEqual(["com.example"]);
    expect(reader.userIds).toEqual([undefined]);
    expect(body).toMatchObject({
      schemaVersion: 1,
      deviceId: "emulator-5554",
      appId: "com.example",
      result: { status: "available", snapshot: { policy: { captureBodies: false } } },
    });
  });

  test("defaults to the foreground app", async () => {
    const adb = new FakeAdbExecutor();
    adb.setForegroundApp({ packageName: "com.foreground", userId: 0 });
    const reader = new FakeSdkCapabilitiesReader();
    setup([android], { createReader: () => reader, adbFactory: new FakeAdbClientFactory(adb) });
    const body = await read("automobile:devices/emulator-5554/sdk/capabilities");
    expect(reader.calls).toEqual(["com.foreground"]);
    expect(reader.userIds).toEqual([0]);
    expect(body.appId).toBe("com.foreground");
  });

  test("forwards the foreground app's work-profile user", async () => {
    const reader = new FakeSdkCapabilitiesReader();
    setup([android], { createReader: () => reader, adbFactory: foregroundAdb("com.work", 10) });
    await read("automobile:devices/emulator-5554/sdk/capabilities");
    expect(reader.calls).toEqual(["com.work"]);
    expect(reader.userIds).toEqual([10]);
  });

  test("an explicit app id in the foreground uses the foreground user", async () => {
    const reader = new FakeSdkCapabilitiesReader();
    setup([android], { createReader: () => reader, adbFactory: foregroundAdb("com.work", 10) });
    await read("automobile:devices/emulator-5554/sdk/capabilities?appId=com.work");
    expect(reader.userIds).toEqual([10]);
  });

  test("an explicit app id that is not in the foreground sends no user", async () => {
    const reader = new FakeSdkCapabilitiesReader();
    setup([android], { createReader: () => reader, adbFactory: foregroundAdb("com.other", 10) });
    await read("automobile:devices/emulator-5554/sdk/capabilities?appId=com.example");
    expect(reader.calls).toEqual(["com.example"]);
    expect(reader.userIds).toEqual([undefined]);
  });

  test("without an app or foreground app reports NO_APP without reading", async () => {
    const reader = new FakeSdkCapabilitiesReader();
    setup([android], { createReader: () => reader });
    const body = await read("automobile:devices/emulator-5554/sdk/capabilities");
    expect(reader.calls).toEqual([]);
    expect(body.result).toEqual({ status: "unavailable", reason: "NO_APP" });
  });

  test("a throwing reader yields an unavailable result, not an empty capability set", async () => {
    const reader = new FakeSdkCapabilitiesReader();
    reader.failure = new Error("socket closed");
    setup([android], { createReader: () => reader });
    const body = await read("automobile:devices/emulator-5554/sdk/capabilities?appId=com.example");
    expect(body.result).toEqual({ status: "unavailable", reason: "CTRLPROXY_UNREACHABLE" });
  });

  test("passes through a typed unavailable state for an older SDK", async () => {
    const reader = new FakeSdkCapabilitiesReader();
    reader.result = { status: "unavailable", reason: "BRIDGE_NOT_INSTALLED" };
    setup([android], { createReader: () => reader });
    const body = await read("automobile:devices/emulator-5554/sdk/capabilities?appId=com.example");
    expect(body.result).toEqual({ status: "unavailable", reason: "BRIDGE_NOT_INSTALLED" });
  });

  test("iOS devices are unavailable with UNSUPPORTED_PLATFORM", async () => {
    const reader = new FakeSdkCapabilitiesReader();
    setup([ios], { createReader: () => reader });
    const body = await read(
      `automobile:devices/${ios.deviceId}/sdk/capabilities?appId=com.example`,
    );
    expect(reader.calls).toEqual([]);
    expect(body.result).toEqual({ status: "unavailable", reason: "UNSUPPORTED_PLATFORM" });
  });

  test("an unknown device reports an error envelope", async () => {
    setup([], {});
    const body = await read("automobile:devices/missing/sdk/capabilities");
    expect(body.error).toContain("Device not found");
  });
});
