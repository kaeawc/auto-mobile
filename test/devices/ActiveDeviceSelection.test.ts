import { describe, expect, test } from "bun:test";
import {
  ActiveDeviceSelection,
  DIRECT_DEVICE_CONNECTION_KEY,
} from "../../src/devices/ActiveDeviceSelection";
import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { BootedDevice } from "../../src/models";

const device = (deviceId: string): BootedDevice => ({
  deviceId,
  name: deviceId,
  platform: "android",
});

describe("ActiveDeviceSelection", () => {
  test("clearPinFor drops the pin only for the pinned device", () => {
    const selection = new ActiveDeviceSelection();
    selection.setPin(device("a"));
    expect(selection.getPin(DIRECT_DEVICE_CONNECTION_KEY)?.deviceId).toBe("a");
    selection.clearPinFor("b");
    expect(selection.getPin()?.deviceId).toBe("a");
    selection.clearPinFor("a");
    expect(selection.getPin()).toBeUndefined();
  });

  test("two DeviceReadiness instances own separate pins and have no current-device API", () => {
    const first = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils()),
    );
    const second = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils()),
    );
    first.setExplicitDevicePin(device("emulator-5554"));
    expect(second.getExplicitDevicePin()).toBeUndefined();
    expect("getCurrentDevice" in first).toBe(false);
    expect("currentDevice" in new ActiveDeviceSelection()).toBe(false);
    expect(first.getExplicitDevicePin()?.deviceId).toBe("emulator-5554");
    first.clearExplicitDevicePin("emulator-5554");
    expect(first.getExplicitDevicePin()).toBeUndefined();
  });
});
