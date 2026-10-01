import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import { setDeviceStateSchema } from "../../../src/server/utilityTools";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeEmulatorConsoleClient } from "../../fakes/FakeEmulatorConsoleClient";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const android: BootedDevice = { platform: "android", deviceId: "emulator-5554", name: "Pixel" };
const ios: BootedDevice = {
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  name: "iPhone",
};
const point = { mode: "static" as const, latitude: 37.7749, longitude: -122.4194 };

describe("setDeviceState location", () => {
  test("uses Android emulator console with longitude first", async () => {
    const adbFactory = new FakeAdbClientFactory();
    adbFactory.getFakeClient().setCommandResult("shell getprop ro.kernel.qemu", "1\n");
    const consoleClient = new FakeEmulatorConsoleClient();
    const ports: number[] = [];
    const result = await new DeviceState(android, {
      adbFactory,
      consoleFactory: (port) => {
        ports.push(port);
        return consoleClient;
      },
    }).setState({ location: point });
    expect(result.success).toBe(true);
    expect(result.location).toMatchObject({
      supported: true,
      ...point,
      method: "android_emulator_console",
    });
    expect(ports).toEqual([5554]);
    expect(consoleClient.calls).toEqual([{ method: "geoFix", args: ["-122.4194", "37.7749"] }]);
  });

  test("uses iOS simctl argv with latitude first", async () => {
    const simctl = new FakeSimCtlClient();
    const args = ["location", ios.deviceId, "set", "37.7749,-122.4194"];
    simctl.setCommandArgsResult(args, "");
    const result = await new DeviceState(ios, { simctl }).setState({ location: point });
    expect(result.success).toBe(true);
    expect(result.location).toMatchObject({ supported: true, ...point, method: "ios_simctl" });
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([{ args, timeoutMs: undefined }]);
  });

  test("rejects invalid coordinates before any command", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const consoleClient = new FakeEmulatorConsoleClient();
    for (const location of [
      { ...point, latitude: NaN },
      { ...point, latitude: Infinity },
      { ...point, latitude: -91 },
      { ...point, longitude: -181 },
      { ...point, longitude: Infinity },
    ]) {
      const result = await new DeviceState(android, {
        adbFactory,
        consoleFactory: () => consoleClient,
      }).setState({ location });
      expect(result.success).toBe(false);
      expect(result.error).toContain("location.");
    }
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
    expect(consoleClient.calls).toEqual([]);
  });

  test("returns actionable unsupported failures for physical devices", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const physicalAndroid = { ...android, deviceId: "R123456" };
    const simctl = new FakeSimCtlClient();
    const physicalIos = { ...ios, deviceId: "00008110-001234567890801E" };
    const androidResult = await new DeviceState(physicalAndroid, { adbFactory }).setState({
      location: point,
    });
    const iosResult = await new DeviceState(physicalIos, { simctl }).setState({ location: point });
    expect(androidResult.location?.supported).toBe(false);
    expect(androidResult.error).toContain("Use an Android emulator");
    expect(iosResult.location?.supported).toBe(false);
    expect(iosResult.error).toContain("Use an iOS Simulator");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("maps a generic console or simctl command failure", async () => {
    const adbFactory = new FakeAdbClientFactory();
    adbFactory.getFakeClient().setCommandResult("shell getprop ro.kernel.qemu", "1\n");
    const consoleClient = new FakeEmulatorConsoleClient();
    consoleClient.failNext("geoFix", new Error("Command exited with code 1"));
    const androidResult = await new DeviceState(android, {
      adbFactory,
      consoleFactory: () => consoleClient,
    }).setState({ location: point });
    expect(androidResult.success).toBe(false);
    expect(androidResult.error).toContain("Command exited with code 1");

    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(
      ["location", ios.deviceId, "set", "37.7749,-122.4194"],
      new Error("Command exited with code 1"),
    );
    const iosResult = await new DeviceState(ios, { simctl }).setState({ location: point });
    expect(iosResult.success).toBe(false);
    expect(iosResult.error).toContain("Command exited with code 1");
  });

  test("advertises a strict, bounded, extensible location mode", () => {
    expect(setDeviceStateSchema.safeParse({ location: point }).success).toBe(true);
    expect(setDeviceStateSchema.safeParse({ location: { ...point, extra: true } }).success).toBe(
      false,
    );
    expect(setDeviceStateSchema.safeParse({ location: { ...point, mode: "route" } }).success).toBe(
      false,
    );
    expect(setDeviceStateSchema.safeParse({ location: { ...point, latitude: 91 } }).success).toBe(
      false,
    );
    expect(setDeviceStateSchema.safeParse({ location: { ...point, longitude: NaN } }).success).toBe(
      false,
    );
  });
});
